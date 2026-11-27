"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema as s } from "@/server/db/client";
import { audit } from "@/server/db/helpers";
import { sessionCookieOptions, PROJECT_COOKIE } from "@/server/auth/session";
import { currentUser } from "@/server/auth/current";
import { analyzeProduct, proposeIcp, ProductProfileSchema } from "@/server/domain/intel/product-analyst";
import { AUDIENCES } from "@/server/domain/intel/market-taxonomy";
import { crawlSite, normalizeUrl, siteFacts } from "@/server/domain/intel/site";
import { activateWorkspace, createWorkspace, replaceIcps, startMission } from "@/server/domain/workspace/setup";
import { budgetChoice, rulesForBudget, setGrowthBudget } from "@/server/domain/growth/monthly-budget";
import { activeMission } from "@/server/queries/missions";
import { BUDGET_PERIOD_DAYS, DEFAULT_MONTHLY_BUDGET_USDC } from "@/lib/budget";
import { toMicro } from "@/lib/money";
import { MISSION_KEYS, templatesFor } from "@/lib/missions";
import { kickWorker } from "@/server/jobs/worker";
import { fail, guard, limited, type ActionResult } from "@/server/actions/_common";

const Amount = z.string().regex(/^\d+(\.\d{1,6})?$/, "Enter a USDC amount");

async function signedInFounder(limitKey: string) {
  const user = await currentUser();
  if (!user) throw new Error("You are signed out");
  if (user.isGuest) throw new Error("Create an account to set up a real workspace");
  if (!user.emailVerified) throw new Error("Confirm your email first — enter the code we sent you.");
  await limited(`${limitKey}:${user.id}`, 6, 0.05);
  return user;
}

// ───────────────────────────── quick start: one link ─────────────────────────────

const QuickStart = z.object({
  url: z.string().trim().min(3, "Enter your website").max(300),
  audience: z.enum(AUDIENCES).optional(),
});

export interface QuickStartSummary {
  name: string;
  category: string;
  audience: string;
  pagesRead: number;
  generatedBy: string;
}

/**
 * Paste a website, get a working workspace: read the site, build the product profile and
 * ideal customers, start a goal that fits the audience, set safe spending rules (every
 * payment asks first). Paid scans are started only after the owner chooses to run one or opts in to Autopilot.
 */
export async function quickStartAction(_: unknown, form: FormData): Promise<ActionResult<QuickStartSummary>> {
  try {
    const user = await signedInFounder("quickstart");
    const raw = String(form.get("audience") ?? "");
    const f = QuickStart.parse({ url: form.get("url"), audience: raw && raw !== "auto" ? raw : undefined });
    const url = normalizeUrl(f.url);
    const site = await crawlSite(url);
    if (!site.home.ok) {
      const host = new URL(url).hostname;
      const blocked = /HTTP (401|403|429)|robots/.test(site.home.note ?? "");
      return {
        ok: false,
        error: blocked
          ? `${host} doesn't allow automated readers (${site.home.note}). Set up step by step instead: paste a sentence about what you sell and GrowTendril does the rest.`
          : `Couldn't open ${host}${site.home.note ? ` (${site.home.note})` : ""}. Check the address, or set up step by step instead.`,
      };
    }
    const facts = siteFacts(site.home, site.pages);
    if (facts.readableChars < 120 && facts.description.length < 20) {
      return { ok: false, error: `${facts.host} has almost no readable text (it may only render in a browser). Set up step by step and describe your product in a sentence.` };
    }
    const description = facts.description.length >= 10 ? facts.description : `${facts.name} — ${site.home.headings.slice(0, 3).join(". ")}`;
    const analysis = await analyzeProduct(
      { name: facts.name, website: facts.url, xHandle: facts.socials.x ?? null, githubUrl: facts.socials.github?.split("/").length === 5 ? facts.socials.github : null, description, audience: f.audience ?? null, competitors: facts.competitors, location: facts.location },
      { pages: site.pages },
    );
    const db = await getDb();
    const icp = await proposeIcp(analysis.profile, facts.name);
    const template = templatesFor(analysis.profile.audience, analysis.profile.category)[0];
    const projectId = await db.transaction(async (tx) => {
    const projectId = await createWorkspace(tx as unknown as typeof db, {
      userId: user.id,
      name: facts.name.slice(0, 80),
      website: facts.url,
      xHandle: facts.socials.x ?? null,
      githubUrl: facts.socials.github ?? null,
      description: description.slice(0, 2000),
      onboardingStep: 4,
      analysis,
    });
    await replaceIcps(tx as unknown as typeof db, projectId, icp.icps);
    // One monthly budget; the largest single payment and daily limit follow from it. Shown for confirmation on the overview.
    await startMission(tx as unknown as typeof db, { projectId, templateKey: template.key, goal: template.goal, days: BUDGET_PERIOD_DAYS, budget: String(DEFAULT_MONTHLY_BUDGET_USDC) });
    await activateWorkspace(tx as unknown as typeof db, { projectId, rules: rulesForBudget({ monthlyMicro: DEFAULT_MONTHLY_BUDGET_USDC * 1_000_000 }), autopilot: "off" });
    await audit(tx as unknown as typeof db, { projectId, actorType: "user", actorId: user.id, action: "workspace.quickstart", data: { url: facts.url, pages: facts.readablePages, generatedBy: analysis.generatedBy } });
    return projectId;
    });
    (await cookies()).set(PROJECT_COOKIE, projectId, sessionCookieOptions);
    kickWorker();
  } catch (e) {
    return fail(e);
  }
  // Navigate from the server: once the workspace exists, the onboarding page re-renders as
  // "finished" and the form that would have navigated client-side is gone.
  redirect("/app?welcome=quick");
}

// ───────────────────────────── step by step ─────────────────────────────

const ProductForm = z.object({
  name: z.string().trim().min(1, "Product name is required").max(80),
  website: z.string().url("Website must be a full URL (https://…)").max(300).optional(),
  docsUrl: z.string().url("Docs must be a full URL").max(300).optional(),
  xHandle: z.string().max(60).optional(),
  githubUrl: z.string().url("GitHub must be a full URL").max(300).optional(),
  description: z.string().trim().min(10, "Describe the product in at least 10 characters").max(2000),
  audience: z.enum(AUDIENCES).optional(),
});

/** Step 1: create the workspace (creator becomes owner) and draft its product profile. */
export async function onboardProductAction(_: unknown, form: FormData): Promise<ActionResult<{ note: string; generatedBy: string }>> {
  try {
    const user = await signedInFounder("onboard");
    const opt = (k: string) => String(form.get(k) ?? "").trim() || undefined;
    const f = ProductForm.parse({ name: form.get("name"), website: opt("website"), docsUrl: opt("docsUrl"), xHandle: opt("xHandle")?.replace(/^@/, ""), githubUrl: opt("githubUrl"), description: form.get("description"), audience: opt("audience") === "auto" ? undefined : opt("audience") });
    const db = await getDb();
    const analysis = await analyzeProduct(f);
    const projectId = await createWorkspace(db, { userId: user.id, ...f, onboardingStep: 2, analysis });
    (await cookies()).set(PROJECT_COOKIE, projectId, sessionCookieOptions);
    await audit(db, { projectId, actorType: "user", actorId: user.id, action: "workspace.create" });
    return { ok: true, data: { note: analysis.note, generatedBy: analysis.generatedBy } };
  } catch (e) {
    return fail(e);
  }
}

export async function onboardIcpAction(): Promise<ActionResult> {
  try {
    const { project, db } = await guard("manage_workspace");
    const [profile] = await db.select().from(s.productProfiles).where(eq(s.productProfiles.projectId, project.id));
    const r = await proposeIcp(ProductProfileSchema.parse({ ...profile, pricing: profile.pricing }), project.name);
    await replaceIcps(db, project.id, r.icps);
    await db.update(s.projects).set({ onboardingStep: Math.max(project.onboardingStep, 3) }).where(eq(s.projects.id, project.id));
    revalidatePath("/onboarding");
    return { ok: true, message: r.note };
  } catch (e) {
    return fail(e);
  }
}

const MissionForm = z.object({
  template: z.enum(MISSION_KEYS),
  goal: z.coerce.number().int().min(1).max(1_000_000),
  days: z.coerce.number().int().min(1).max(180).default(BUDGET_PERIOD_DAYS),
  budget: z.string().regex(/^\d+(\.\d{1,6})?$/, "Enter your monthly budget as a number, like 100"),
});

/** Step 3 (also "New goal" later): pauses the active goal and starts a new one with its monthly budget. */
export async function onboardMissionAction(_: unknown, form: FormData): Promise<ActionResult<{ done: boolean }>> {
  try {
    const { project, db, user } = await guard("manage_policy");
    const f = MissionForm.parse({ template: form.get("template"), goal: form.get("goal"), days: form.get("days") ?? undefined, budget: form.get("budget") });
    if (toMicro(f.budget) <= 0) return { ok: false, error: "Enter a monthly budget above $0. You can change it any time." };
    const before = project.onboardingStep >= 5 ? await budgetChoice(db, project.id, await activeMission(db, project.id)) : null;
    await startMission(db, { projectId: project.id, templateKey: f.template, goal: f.goal, days: f.days, budget: f.budget, dataMode: project.dataMode });
    // A finished workspace keeps its largest payment and research allowance, re-applied to the new budget.
    if (before) {
      const monthlyMicro = toMicro(f.budget);
      await setGrowthBudget(db, { projectId: project.id, actorId: user.id, monthlyMicro, largestPaymentMicro: Math.min(before.largestPaymentMicro, monthlyMicro), researchMonthlyMicro: Math.min(before.researchMonthlyMicro, monthlyMicro) });
    }
    await db.update(s.projects).set({ onboardingStep: Math.max(project.onboardingStep, 4) }).where(eq(s.projects.id, project.id));
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "mission.create", data: { template: f.template, goal: f.goal, budget: f.budget } });
    revalidatePath("/onboarding");
    revalidatePath("/app", "layout");
    return { ok: true, data: { done: project.onboardingStep >= 5 } };
  } catch (e) {
    return fail(e);
  }
}

const AutonomyForm = z.object({
  research: z.enum(["on", "off"]),
  researchMonthly: z.union([Amount, z.literal("")]).optional(),
  autopilot: z.enum(["off", "hourly", "every_6h", "daily"]),
});

/** Step 4: spending limits, derived from the monthly budget. Activates the workspace. */
export async function onboardAutonomyAction(_: unknown, form: FormData): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_policy");
    const f = AutonomyForm.parse({ research: form.get("research") === "on" ? "on" : "off", researchMonthly: form.get("researchMonthly") ?? "", autopilot: form.get("autopilot") });
    const mission = await activeMission(db, project.id);
    if (!mission) return { ok: false, error: "Set a goal and monthly budget first (the step before this one)." };
    const researchMonthlyMicro = f.research === "on" ? Math.min(toMicro(f.researchMonthly || "0"), mission.budgetMicro) : 0;
    if (f.research === "on" && researchMonthlyMicro <= 0) return { ok: false, error: "Enter how much research GrowTendril may buy on its own each month, or turn that off." };
    const choice = { monthlyMicro: mission.budgetMicro, researchMonthlyMicro };
    await activateWorkspace(db, { projectId: project.id, rules: rulesForBudget(choice), autopilot: f.autopilot });
    await setGrowthBudget(db, { projectId: project.id, actorId: user.id, ...choice });
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "workspace.activate", data: { autopilot: f.autopilot, researchMonthlyMicro } });
    kickWorker();
  } catch (e) {
    return fail(e);
  }
  redirect("/app?welcome=1");
}
