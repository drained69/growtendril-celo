"use client";
import { useActionState, useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Globe, Loader2, Sparkles } from "lucide-react";
import { onboardAutonomyAction, onboardIcpAction, onboardMissionAction, onboardProductAction, quickStartAction } from "@/server/actions/onboarding";
import { Button, Callout, Field, Input, Textarea, cn } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { templatesFor } from "@/lib/missions";
import { keepValues } from "@/components/ui/submit";
import { autopilotCostLabel, SERVICES } from "@/lib/services";
import { DEFAULT_MONTHLY_BUDGET_USDC, deriveLimits } from "@/lib/budget";
import { UsdcHelp } from "@/components/features/billing/usdc-help";
import { fmtUsdc, toMicro } from "@/lib/money";

function StepFooter({ children, error, note }: { children: ReactNode; error?: string | null; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <span className="min-w-0 text-[11.5px] text-ink-3">{error ? <span className="text-critical">{error}</span> : note}</span>
      {children}
    </div>
  );
}

// ───────────────────────────── step 1 ─────────────────────────────

const AUDIENCE_CHOICES = [
  { value: "auto", label: "Let GrowTendril decide", hint: "Detected from your description" },
  { value: "consumers", label: "Consumers", hint: "People, households, shoppers" },
  { value: "businesses", label: "Businesses", hint: "Companies, teams, professionals" },
  { value: "developers", label: "Developers", hint: "Engineers and technical teams" },
];

export function ProductStep() {
  const [state, action, pending] = useActionState(onboardProductAction, null);
  const [audience, setAudience] = useState("auto");
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      if (state.data?.note) toast.info("Profile drafted", state.data.note);
      router.push("/onboarding");
      router.refresh();
    }
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepValues(action)}>
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product or business name" htmlFor="ob-name" required>
            <Input id="ob-name" name="name" required maxLength={80} placeholder="Crumb & Co." autoFocus />
          </Field>
          <Field label="Website" htmlFor="ob-web">
            <Input id="ob-web" name="website" type="url" placeholder="https://…" />
          </Field>
        </div>
        <Field label="Short description" htmlFor="ob-desc" required hint="What it does, who it's for, and where, if it's local. At least 10 characters.">
          <Textarea id="ob-desc" name="description" required minLength={10} maxLength={2000} rows={3} placeholder="Weekly sourdough delivery for busy families in Austin…" />
        </Field>
        <div>
          <div className="text-[12.5px] font-medium text-ink">Who are your customers?</div>
          <input type="hidden" name="audience" value={audience} />
          <div className="mt-2">
            <AudiencePicker value={audience} onChange={setAudience} />
          </div>
        </div>
        <details className="group rounded-[8px] border border-line">
          <summary className="cursor-pointer select-none px-3 py-2 text-[12.5px] font-medium text-ink-2 hover:text-ink">More public pages to read (optional)</summary>
          <div className="grid gap-4 border-t border-line p-3 sm:grid-cols-2">
            <Field label="Help center or docs" htmlFor="ob-docs">
              <Input id="ob-docs" name="docsUrl" type="url" placeholder="https://help…" />
            </Field>
            <Field label="X account" htmlFor="ob-x">
              <Input id="ob-x" name="xHandle" placeholder="@handle" />
            </Field>
            <Field label="GitHub repository" htmlFor="ob-gh" className="sm:col-span-2" hint="For software products only">
              <Input id="ob-gh" name="githubUrl" type="url" placeholder="https://github.com/org/repo" />
            </Field>
          </div>
        </details>
      </div>
      <StepFooter error={!pending && state && !state.ok ? state.error : null} note="GrowTendril reads only the public pages you list (respecting robots.txt). You can correct everything next.">
        <Button type="submit" variant="primary" size="md" loading={pending} icon={<Sparkles />}>
          {pending ? "Reading public pages…" : "Build product profile"}
        </Button>
      </StepFooter>
    </form>
  );
}

// ───────────────────────────── quick start ─────────────────────────────

function AudiencePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Who are your customers">
      {AUDIENCE_CHOICES.map((a) => (
        <button
          key={a.value}
          type="button"
          role="radio"
          aria-checked={value === a.value}
          onClick={() => onChange(a.value)}
          className={cn("rounded-[8px] border px-3 py-2 text-left transition-colors", value === a.value ? "border-accent bg-accent/10 ring-1 ring-accent/30" : "border-line hover:border-line-strong hover:bg-surface-2")}
        >
          <span className="block text-[12.5px] font-medium text-ink">{a.label}</span>
          <span className="block text-[11px] text-ink-3">{a.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** One link in, a working workspace out. */
export function QuickStartStep({ website = "" }: { website?: string }) {
  const [state, action, pending] = useActionState(quickStartAction, null);
  const [audience, setAudience] = useState("auto");
  const router = useRouter();
  useEffect(() => {
    if (state?.ok && state.data) {
      toast.success(`${state.data.name} is set up`, `Read ${state.data.pagesRead} page${state.data.pagesRead === 1 ? "" : "s"} · ${state.data.category}`);
      router.push("/app?welcome=quick");
      router.refresh();
    }
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepValues(action)}>
      <div className="space-y-4 p-4">
        <Field label="Your website" htmlFor="qs-url" required hint="GrowTendril reads your public pages (respecting robots.txt) and sets everything up. You can change anything afterwards.">
          <div className="relative">
            <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-4" />
            <Input id="qs-url" name="url" required inputMode="url" autoComplete="url" placeholder="yourbusiness.com" defaultValue={website} autoFocus className="h-11 pl-9 text-[14px]" disabled={pending} />
          </div>
        </Field>
        <div>
          <div className="mb-2 text-[12.5px] font-medium text-ink">Who are your customers?</div>
          <input type="hidden" name="audience" value={audience} />
          <AudiencePicker value={audience} onChange={setAudience} />
        </div>
        {pending && (
          <div role="status" className="flex items-start gap-2 rounded-[8px] border border-line bg-surface-2/50 p-3 text-[12.5px] text-ink-2">
            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent" />
            <p>Reading your public pages and preparing your product, your ideal customer, a first goal and a starting budget of {DEFAULT_MONTHLY_BUDGET_USDC} USDC a month. You&apos;ll check all of it next.</p>
          </div>
        )}
        {!pending && state && !state.ok && <Callout tone="danger">{state.error}</Callout>}
      </div>
      <StepFooter note={`Setup is free. Scans are paid from credit (the GrowTendril fee). We always ask before paying a person. Starting budget: ${DEFAULT_MONTHLY_BUDGET_USDC} USDC a month — you can change it any time.`}>
        <Button type="submit" variant="primary" size="md" loading={pending} icon={<Sparkles />}>
          {pending ? "Preparing your workspace…" : "Build my workspace"}
        </Button>
      </StepFooter>
    </form>
  );
}

// ───────────────────────────── step 2 ─────────────────────────────

export function GenerateIcp() {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="primary"
      size="md"
      loading={pending}
      onClick={() =>
        start(async () => {
          const r = await onboardIcpAction();
          if (r.ok) toast.success("Ideal customer suggested", r.message);
          else toast.error("Couldn’t suggest your ideal customer", r.error);
          router.refresh();
        })
      }
    >
      {pending ? "Suggesting your ideal customer…" : "Looks right — suggest my ideal customer"}
      {!pending && <ArrowRight />}
    </Button>
  );
}

// ───────────────────────────── step 3 ─────────────────────────────

export function MissionStep({ audience, category }: { audience?: string | null; category?: string | null }) {
  const [state, action, pending] = useActionState(onboardMissionAction, null);
  const TEMPLATES = templatesFor(audience, category);
  const [t, setT] = useState(TEMPLATES[0]);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      router.push(state.data?.done ? "/app/missions" : "/onboarding");
      router.refresh();
    }
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepValues(action)}>
      <div className="space-y-4 p-4">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Goal">
          {TEMPLATES.map((x) => {
            const active = t.key === x.key;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                key={x.key}
                onClick={() => setT(x)}
                className={cn("flex items-start gap-2.5 rounded-[8px] border px-3 py-2.5 text-left transition-colors", active ? "border-accent bg-accent/10 ring-1 ring-accent/30" : "border-line hover:border-line-strong hover:bg-surface-2")}
              >
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1 [&_svg]:size-2.5", active ? "bg-accent text-white ring-accent" : "ring-line-strong")}>{active && <Check />}</span>
                <span>
                  <span className="block text-[13px] font-medium text-ink">{x.name}</span>
                  <span className="block text-[11.5px] text-ink-3">{x.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        <input type="hidden" name="template" value={t.key} />
        <div className="grid gap-3 sm:grid-cols-2" key={t.key}>
          <Field label="How many a month" htmlFor="ms-goal" hint={t.goalDescription}>
            <Input id="ms-goal" name="goal" type="number" required min={1} max={1000000} step={1} defaultValue={t.goal} inputMode="numeric" className="num" />
          </Field>
          <Field label="Monthly growth budget" htmlFor="ms-budget" hint="The most GrowTendril can spend on tests each month. You can change this any time.">
            <div className="relative">
              <Input id="ms-budget" name="budget" type="number" required min={1} step="0.000001" defaultValue={DEFAULT_MONTHLY_BUDGET_USDC} inputMode="decimal" className="num pr-12" />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-ink-4">USDC</span>
            </div>
          </Field>
        </div>
        <UsdcHelp compact />
      </div>
      <StepFooter error={!pending && state && !state.ok ? state.error : null} note="A budget is a limit, not a charge. Nothing is paid until you approve it, and unspent money stays yours.">
        <Button type="submit" variant="primary" size="md" loading={pending}>
          Set goal and budget
          {!pending && <ArrowRight />}
        </Button>
      </StepFooter>
    </form>
  );
}

// ───────────────────────────── step 4 ─────────────────────────────

export function AutonomyStep({ autopilot, billing, monthlyMicro }: { autopilot: Record<string, string>; billing?: boolean; monthlyMicro: number }) {
  const [state, action, pending] = useActionState(onboardAutonomyAction, null);
  const [cadence, setCadence] = useState("off");
  const [research, setResearch] = useState(false);
  const [researchMonthly, setResearchMonthly] = useState(String(Math.min(5, monthlyMicro / 1e6)));
  const limits = deriveLimits({ monthlyMicro, researchMonthlyMicro: research && /^\d+(\.\d{1,6})?$/.test(researchMonthly) ? toMicro(researchMonthly) : 0 });
  return (
    <form action={action} onSubmit={keepValues(action)}>
      <div className="divide-y divide-line">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
          <span><span className="block text-[12.5px] font-medium text-ink">Monthly growth budget</span><span className="block text-[11.5px] text-ink-3">From the last step. It starts again every 30 days.</span></span>
          <span className="num text-[13px] font-medium text-ink">{fmtUsdc(monthlyMicro)}</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
          <span><span className="block text-[12.5px] font-medium text-ink">Largest single payment</span><span className="block text-[11.5px] text-ink-3">A quarter of your budget, at most $50. No payment can be bigger, even with your OK.</span></span>
          <span className="num text-[13px] font-medium text-ink">{fmtUsdc(limits.hardCeilingMicro)}</span>
        </div>
        <div className="px-4 py-3 text-[12.5px] text-ink-2">
          <span className="font-medium text-ink">Payments to people:</span> GrowTendril always asks you first.
        </div>
        <div className="space-y-2 px-4 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
            <input type="checkbox" name="research" checked={research} onChange={(e) => setResearch(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            Let GrowTendril buy research on its own, up to
            <span className="relative inline-block w-24"><Input aria-label="Research per month in USDC" name="researchMonthly" inputMode="decimal" value={researchMonthly} onChange={(e) => setResearchMonthly(e.target.value)} disabled={!research} className="num h-7 pr-10 text-right" /><span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10.5px] text-ink-4">USDC</span></span>
            a month
          </label>
          <p className="text-[11.5px] text-ink-3">Off: it asks you before buying anything. You can change all of this in Settings → Budget.</p>
        </div>
      </div>

      <div className="border-t border-line p-4">
        <div className="text-[12.5px] font-medium text-ink">Autopilot</div>
        <p className="text-[11.5px] text-ink-3">
          How often GrowTendril scans for customers on its own. You can change this in Settings.
          {billing && <> Each scan costs {SERVICES.scan.priceUsdc} USDC of credit (the GrowTendril fee), separate from your growth budget. If it&apos;s on, an overdue scan can start as soon as you add credit.</>}
        </p>
        <input type="hidden" name="autopilot" value={cadence} />
        <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Autopilot cadence">
          {Object.entries(autopilot).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={cadence === k}
              onClick={() => setCadence(k)}
              className={cn("h-7 rounded-[6px] border px-2.5 text-[12px] transition-colors disabled:opacity-40", cadence === k ? "border-accent bg-accent/10 text-ink" : "border-line-strong text-ink-3 hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        {billing && <p className={cn("num mt-2 text-[11.5px]", cadence === "hourly" ? "text-warning" : "text-ink-3")}>{autopilotCostLabel(cadence)}</p>}
        {billing && cadence === "hourly" && <Callout tone="warn" className="mt-2">Hourly means 24 scans a day — about {24 * SERVICES.scan.priceUsdc} USDC of credit a day. Most businesses do well with once a day.</Callout>}
      </div>

      <div className="grid gap-2 border-t border-line p-4 text-[12px] sm:grid-cols-3">
        <div className="rounded-[8px] border border-good/30 bg-good/[0.04] p-2.5">
          <div className="label text-good">Does on its own</div>
          <div className="mt-1 text-ink-2">Finding customers and creators · scoring · your growth plan · creator briefs · counting results{research ? " · buying research up to your monthly limit" : ""}</div>
        </div>
        <div className="rounded-[8px] border border-warning/30 bg-warning/[0.04] p-2.5">
          <div className="label text-warning">Asks you first</div>
          <div className="mt-1 text-ink-2">Every payment to a person · bounties · content{research ? "" : " · research"} · anything above your limits</div>
        </div>
        <div className="rounded-[8px] border border-critical/30 bg-critical/[0.04] p-2.5">
          <div className="label text-critical">Never</div>
          <div className="mt-1 text-ink-2">Mass messages · automated DMs, cold email or mentions</div>
        </div>
      </div>

      {!pending && state && !state.ok && (
        <div className="px-4 pb-4">
          <Callout tone="danger">{state.error}</Callout>
        </div>
      )}
      <StepFooter note={billing ? "Your first scan starts when you click Scan for customers, or when Autopilot runs." : "Activating starts your first scan right away."}>
        <Button type="submit" variant="primary" size="md" loading={pending}>
          {pending ? "Activating…" : "Activate GrowTendril"}
          {!pending && <ArrowRight />}
        </Button>
      </StepFooter>
    </form>
  );
}
