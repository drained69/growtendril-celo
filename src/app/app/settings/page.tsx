import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { AlertTriangle, Bot, Building2, FileText, Mail, PiggyBank, ShieldCheck, Target, UserRound } from "lucide-react";
import { activeMission } from "@/server/queries/missions";
import { budgetChoice, monthUsage } from "@/server/domain/growth/monthly-budget";
import { resetLabel } from "@/lib/budget";
import { BudgetForm } from "@/components/features/settings/budget-form";
import { balanceMicro, billingMode } from "@/server/domain/billing";
import { fmtUsdc } from "@/lib/money";
import { googleConfigured } from "@/server/auth/google";
import { signOutEverywhereAction } from "@/server/actions/auth";
import { requireProject } from "@/server/auth/current";
import { can, ROLE_LABEL } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { effectivePaymentCeiling } from "@/server/domain/agent/policy";
import { listMembers } from "@/server/domain/workspace/members";
import { AUTOPILOT_LABEL } from "@/server/jobs/scheduler";
import { microToDecimal } from "@/lib/money";
import { relTime } from "@/lib/time";
import { Badge, Callout, Card, CardHeader, CardBody, CardFooter, EmptyState, LinkButton, ModeBadge, PageHeader } from "@/components/ui";
import { AutopilotControl, IcpForm, LeaveWorkspace, PolicyForm, ProfileForm, WorkspaceForm } from "@/components/features/settings/settings-forms";

const SECTIONS = [
  { id: "workspace", label: "Workspace", icon: <Building2 /> },
  { id: "profile", label: "Product profile", icon: <FileText /> },
  { id: "icp", label: "Ideal customer", icon: <Target /> },
  { id: "budget", label: "Budget", icon: <PiggyBank /> },
  { id: "autopilot", label: "Autopilot", icon: <Bot /> },
  { id: "account", label: "Account & billing", icon: <UserRound /> },
  { id: "danger", label: "Danger zone", icon: <AlertTriangle /> },
];

const EMAIL_KIND: Record<string, string> = {
  verify_code: "Verification code",
  reset_code: "Password reset code",
  welcome: "Welcome",
  subscription_active: "Payment received",
  renewal_reminder: "Renewal reminder",
  payment_failed: "Payment failed",
  subscription_canceled: "Plan ended",
  credit_added: "Credit added",
  invite: "Workspace invite",
  report: "Report",
};

export default async function Settings() {
  const { project, role, db, user } = await requireProject();
  const pid = project.id;
  const [[profile], icps, [policy], members, credit, emails] = await Promise.all([
    db.select().from(s.productProfiles).where(eq(s.productProfiles.projectId, pid)),
    db.select().from(s.icps).where(eq(s.icps.projectId, pid)),
    db.select().from(s.policies).where(eq(s.policies.projectId, pid)),
    listMembers(db, pid),
    balanceMicro(db, project.ownerId),
    db.select().from(s.emailLog).where(eq(s.emailLog.userId, user.id)).orderBy(desc(s.emailLog.createdAt)).limit(6),
  ]);
  const mission = await activeMission(db, pid);
  const [choice, usage] = await Promise.all([budgetChoice(db, pid, mission), mission ? monthUsage(db, mission) : Promise.resolve(null)]);
  const mode = billingMode();
  const canWorkspace = can(role, "manage_workspace");
  const canPolicy = can(role, "manage_policy");
  const owners = members.filter((m) => m.role === "owner").length;
  const leaveBlocked = role === "owner" && owners <= 1 ? "You are the only owner — promote another member to owner first." : undefined;

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your workspace, what GrowTendril knows about your product and customers, your budget, and Autopilot."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            <span>
              Your role: <span className="text-ink-2">{ROLE_LABEL[role]}</span>
            </span>
          </>
        }
        actions={
          <>
            <LinkButton href="/app/team">Team</LinkButton>
            <LinkButton href="/app/integrations">Integrations</LinkButton>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-4 space-y-0.5">
            {SECTIONS.map((x) => (
              <li key={x.id}>
                <a href={`#${x.id}`} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink [&_svg]:size-3.5">
                  {x.icon}
                  {x.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          {!canWorkspace && !canPolicy && <Callout tone="info" title="Read-only">Your role can view settings but not change them. Ask an owner or admin for changes.</Callout>}

          <Card id="workspace" className="scroll-mt-4">
            <CardHeader title="Workspace" description="Name and public links for this product." icon={<Building2 />} />
            <WorkspaceForm w={{ name: project.name, website: project.website, docsUrl: project.docsUrl, githubUrl: project.githubUrl, xHandle: project.xHandle }} disabled={!canWorkspace} />
          </Card>

          <Card id="profile" className="scroll-mt-4">
            <CardHeader
              title="Your product"
              description="What GrowTendril believes you sell. Fix anything that's wrong — the search words here decide what it looks for."
              icon={<FileText />}
              action={
                profile && (
                  <>
                    <Badge>{["claude", "gemini"].includes(profile.generatedBy) ? "AI draft" : "From your pages"}</Badge>
                    {profile.founderEdited && <Badge tone="info">edited</Badge>}
                  </>
                )
              }
            />
            {profile ? (
              <>
                <ProfileForm p={profile} disabled={!canWorkspace} />
                <CardFooter className="block">
                  <span className="label mr-2">Sources read</span>
                  {profile.crawledSources.length ? (
                    profile.crawledSources.map((c) => (
                      <span key={c.url} className="mr-3 inline-flex items-center gap-1">
                        <span className={c.ok ? "text-good" : "text-critical"}>{c.ok ? "✓" : "✕"}</span>
                        <span className="num text-ink-2">{c.url}</span>
                        {!c.ok && c.note && <span className="text-ink-4">({c.note})</span>}
                      </span>
                    ))
                  ) : (
                    <span>None — the profile was drafted from your description only.</span>
                  )}
                </CardFooter>
              </>
            ) : (
              <CardBody>
                <EmptyState title="No product profile" description="The profile is created during onboarding from your product's public pages." action={<LinkButton href="/onboarding">Open onboarding</LinkButton>} />
              </CardBody>
            )}
          </Card>

          <Card id="icp" className="scroll-mt-4">
            <CardHeader title="Your ideal customer" description="Who GrowTendril looks for when it checks whether a company is a good fit." icon={<Target />} />
            {icps.length ? (
              <IcpForm icps={icps} disabled={!canWorkspace} />
            ) : (
              <CardBody className="text-[12.5px] text-ink-3">Not set yet. GrowTendril suggests one from your product profile during setup.</CardBody>
            )}
          </Card>

          <Card id="budget" className="scroll-mt-4">
            <CardHeader title="Budget" description="One monthly number, the largest single payment, and what GrowTendril may buy on its own." icon={<PiggyBank />} />
            {mission && choice ? (
              <BudgetForm disabled={!canPolicy} current={choice} usage={usage ? `This month: ${fmtUsdc(usage.usedMicro)} of ${fmtUsdc(usage.budgetMicro)} used · resets on ${resetLabel(usage.resetsAt)}. Unspent money doesn't roll over.` : undefined} />
            ) : (
              <CardBody className="text-[12.5px] text-ink-3">{choice ? "Set a goal first — your monthly budget belongs to it." : "Finish setting up your workspace first."} <Link className="underline" href={choice ? "/onboarding?step=3" : "/onboarding"}>{choice ? "Set a goal" : "Continue setup"}</Link></CardBody>
            )}
          </Card>

          <Card id="policy" className="scroll-mt-4">
            <CardHeader
              title="Advanced: exact limits"
              description="The detailed limits behind your budget. Saving your budget above resets them to match it. Every payment is checked against them, and your Payout account enforces them too once you confirm them in your wallet."
              icon={<ShieldCheck />}
              action={
                policy && (
                  <span className="flex items-center gap-1.5">
                    <Badge tone={policy.autonomyEnabled ? "good" : "muted"}>{policy.autonomyEnabled ? `Research on its own ≤ ${microToDecimal(Math.min(policy.maxTransactionMicro, effectivePaymentCeiling(policy)))} USDC` : "Always asks"}</Badge>
                    <Badge className="num">version {policy.version}</Badge>
                  </span>
                )
              }
            />
            {policy ? (
              <details className="group">
                <summary className="cursor-pointer px-4 py-3 text-[12.5px] font-medium text-ink-2 hover:text-ink">Show exact limits</summary>
                <PolicyForm
                  disabled={!canPolicy}
                  p={{
                    autonomousLimit: policy.autonomyEnabled ? microToDecimal(Math.min(policy.maxTransactionMicro, effectivePaymentCeiling(policy))) : "0",
                    dailySpend: microToDecimal(policy.dailySpendMicro),
                    hardCeiling: microToDecimal(effectivePaymentCeiling(policy)),
                    forbidden: policy.forbiddenActions,
                    tokens: policy.allowedTokens,
                  }}
                />
                <CardFooter>Last changed {relTime(policy.updatedAt)}</CardFooter>
              </details>
            ) : (
              <CardBody className="text-[12.5px] text-ink-3">No limits yet. They are set in the last setup step.</CardBody>
            )}
          </Card>

          <Card id="autopilot" className="scroll-mt-4">
            <CardHeader
              title="Autopilot"
              description="How often GrowTendril scans for customers on its own. Each scan is paid from your credit (the GrowTendril fee). Every payment still follows your budget."
              icon={<Bot />}
              action={<Badge tone={project.autopilot === "off" ? "muted" : "good"} dot={project.autopilot !== "off"}>{AUTOPILOT_LABEL[project.autopilot] ?? project.autopilot}</Badge>}
            />
            <AutopilotControl value={project.autopilot} labels={AUTOPILOT_LABEL} disabled={!canPolicy} billing={mode !== "off"} />
            <CardFooter>
              <span>{project.lastCycleAt ? `Last scan ${relTime(project.lastCycleAt)}` : "No scan has run yet"}</span>
              <Link href="/app/runs" className="hover:text-ink">
                See scan history →
              </Link>
            </CardFooter>
          </Card>

          <Card id="account" className="scroll-mt-4">
            <CardHeader title="Account & billing" description="Your sign-in, your credit for scans, and what GrowTendril has emailed you." icon={<UserRound />} />
            <ul className="divide-y divide-line text-[12.5px]">
              <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium text-ink">{user.email}</div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    Sign-in: {[user.hasPassword && "password", user.googleLinked && "Google"].filter(Boolean).join(" and ") || "—"}
                  </div>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={user.emailVerified ? "good" : "warn"}>{user.emailVerified ? "Email verified" : "Not verified"}</Badge>
                  {googleConfigured() && !user.googleLinked && (
                    <a href="/api/auth/google?next=/app/settings%23account" className="text-[12px] text-ink-2 underline-offset-2 hover:underline">
                      Link Google
                    </a>
                  )}
                  <Link href={`/forgot?email=${encodeURIComponent(user.email)}`} className="text-[12px] text-ink-2 underline-offset-2 hover:underline">
                    {user.hasPassword ? "Change password" : "Add a password"}
                  </Link>
                </span>
              </li>
              {mode !== "off" && (
                <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="font-medium text-ink">
                      Credit <span className="num ml-1">{fmtUsdc(credit)}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-3">{project.ownerId === user.id ? "Pays the GrowTendril fee for scans and reports in workspaces you own. Separate from your growth budget." : "Scans in this workspace are paid from its owner's credit."}</div>
                  </div>
                  <span className="flex items-center gap-2">
                    <LinkButton href="/billing" size="sm">
                      Billing
                    </LinkButton>
                  </span>
                </li>
              )}
              <li className="px-4 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 font-medium text-ink">
                  <Mail className="size-3.5 text-ink-3" /> Emails sent to you
                </div>
                {emails.length ? (
                  <ul className="space-y-1 text-[12px] text-ink-3">
                    {emails.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          <span className="text-ink-2">{EMAIL_KIND[e.kind] ?? e.kind}</span> — {e.subject.replace(/^\d{6} is your /, "Your ")}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone={e.status === "sent" ? "good" : e.status === "logged" ? "muted" : "bad"}>{e.status === "logged" ? "dev console" : e.status}</Badge>
                          <span className="num">{relTime(e.createdAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-ink-3">Nothing yet.</p>
                )}
              </li>
              <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="font-medium text-ink">Sign out everywhere</div>
                  <div className="mt-0.5 text-[12px] text-ink-3">Ends every session on every device, including this one.</div>
                </div>
                <form action={signOutEverywhereAction}>
                  <button type="submit" className="rounded-[6px] border border-line-strong px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-2">
                    Sign out everywhere
                  </button>
                </form>
              </li>
            </ul>
          </Card>

          <Card id="danger" className="scroll-mt-4 border-critical/30">
            <CardHeader title="Danger zone" icon={<AlertTriangle className="text-critical" />} />
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-ink">Leave this workspace</div>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {leaveBlocked ?? `Removes ${user.email} from ${project.name}. Data stays with the workspace.`}
                </p>
              </div>
              <LeaveWorkspace workspace={project.name} blocked={leaveBlocked} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
