import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { ArrowUpRight, CheckCircle2, Inbox, Lock, PackageCheck, ShieldAlert, UserRoundCheck } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { fmtUsdc, microToDecimal } from "@/lib/money";
import { relTime } from "@/lib/time";
import { Badge, Callout, Card, CardBody, CardHeader, Confidence, EmptyState, ModeBadge, PageHeader, Stat, StatStrip, StatusBadge } from "@/components/ui";
import { DataTable } from "@/components/ui/data-table";
import { toDataSuffix } from "@celo/attribution-tags";
import { ApprovalControls } from "@/components/features/approvals/approval-controls";
import { currentPayee, payeeContext, payeeHold, PAYEE_HOLD_MS, type PayeeContext } from "@/server/domain/agent/payees";
import { CopyField } from "@/components/ui/copy";

type Details = {
  rationale?: string;
  reasons?: string[];
  expectedOutcome?: string | null;
  evidence?: { url: string; title: string }[];
  confidence?: number;
  policy?: { rule: string; detail: string }[];
  tranche?: "first" | "second";
  delivery?: { url: string; note: string | null; recordedAt: string; recordedBy: string | null; visits: number; conversions: number; successEvent: string } | null;
};

/** Who a pending payment goes to, with the history an approver needs to spot a swapped address. */
interface Payee {
  address: string;
  label: string | null;
  ctx: PayeeContext;
  /** The address the experiment pays now, if it differs from the one in this request. */
  changedTo: string | null | undefined;
  hold: string | null;
}

const humanize = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Why a payment waits for you, in plain words. The rule codes stay under "Details". */
const WHY: Record<string, string> = {
  PAYMENT_TO_PERSON: "this pays a person",
  KOL_APPROVAL_THRESHOLD: "creator payments always ask you",
  BOUNTY_APPROVAL_THRESHOLD: "bounty payments always ask you",
  MAINNET_FOUNDER_APPROVAL: "you haven't let GrowTendril spend on its own",
  CATEGORY_REQUIRES_APPROVAL: "this kind of spending always asks you",
  MAX_TRANSACTION: "it's more than GrowTendril may spend on its own at once",
  DAILY_SPEND: "it would go over today's limit",
  CATEGORY_BUDGET: "it would go over this month's allowance for this kind of spending",
  APPROVED_SERVICES: "this service isn't on your approved list",
  REALLOCATION_SIZE: "it moves a large part of your budget",
};
function whyAsking(policy: Details["policy"]): string {
  const rules = (policy ?? []).map((p) => p.rule);
  if (rules.includes("PAYMENT_TO_PERSON")) return "We're asking because this pays a person.";
  const reasons = [...new Set(rules.map((r) => WHY[r]).filter(Boolean))].filter((r) => r !== WHY.MAINNET_FOUNDER_APPROVAL || rules.length === 1);
  return reasons.length ? `We're asking because ${reasons.slice(0, 2).join(", and ")}.` : "We're asking because it needs your OK.";
}

export default async function Approvals() {
  const { project, role, db, user } = await requireProject();
  const canApprove = can(role, "approve");
  const rows = await db
    .select({ a: s.approvals, d: s.agentDecisions })
    .from(s.approvals)
    .innerJoin(s.agentDecisions, eq(s.approvals.decisionId, s.agentDecisions.id))
    .where(eq(s.approvals.projectId, project.id))
    .orderBy(desc(s.approvals.createdAt));
  const pending = rows.filter((r) => r.a.status === "pending");
  const payees = await payeesFor(db, project.id, user.id, pending.map((r) => r.a.transactionId).filter((x): x is string => !!x));
  const [workspaceWallet] = await db.select({ provider: s.wallets.provider }).from(s.wallets).where(eq(s.wallets.projectId, project.id));
  const pendingTxIds = pending.map((r) => r.a.transactionId).filter((x): x is string => !!x);
  // Payments from a workspace contract are approved by the owner's own wallet signature.
  const onchainSends = new Set(workspaceWallet?.provider === "growth_vault" && pendingTxIds.length ? (await db.select({ id: s.transactions.id, kind: s.transactions.kind }).from(s.transactions).where(inArray(s.transactions.id, pendingTxIds))).filter((t) => t.kind === "send").map((t) => t.id) : []);
  const code = process.env.CELO_ATTRIBUTION_CODE;
  const attribution = code && /^[a-z0-9_]{1,32}$/.test(code) ? toDataSuffix(code) as `0x${string}` : null;
  const done = rows.filter((r) => r.a.status !== "pending");
  const pendingTotal = pending.reduce((n, r) => n + r.a.requestedMicro, 0);
  const approvedTotal = done.filter((r) => r.a.status === "approved").reduce((n, r) => n + (r.a.approvedMicro ?? r.a.requestedMicro), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Approvals"
        description="Payments waiting for your OK. Saying yes pays this one payment; your monthly budget, largest single payment and pause switch still apply. With a Payout account, you confirm each one in your own wallet."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            {pending.length ? <span>{pending.length} waiting</span> : <span>Nothing waiting</span>}
          </>
        }
      />

      <StatStrip className="grid-cols-2 lg:grid-cols-4">
        <Stat label="Waiting" value={pending.length} tone={pending.length ? "warn" : undefined} sub="for your OK" />
        <Stat label="Asked for" value={fmtUsdc(pendingTotal, { unit: false })} sub="USDC waiting for you" />
        <Stat label="Decided" value={done.length} sub={`${done.filter((r) => r.a.status === "approved").length} paid · ${done.filter((r) => r.a.status === "rejected").length} not paid`} />
        <Stat label="Paid so far" value={fmtUsdc(approvedTotal, { unit: false })} sub="USDC, all time" />
      </StatStrip>

      {!canApprove && pending.length > 0 && (
        <Callout tone="info" title="View only">
          Only owners and admins can say yes or no to payments. You can still read why each one was suggested.
        </Callout>
      )}

      {pending.length ? (
        <div className="space-y-4">
          {pending.map(({ a, d }) => {
            const det = a.details as Details;
            const payee = a.transactionId ? payees.get(a.transactionId) : undefined;
            const who = payee ? payee.label ?? "this person" : null;
            return (
              <Card key={a.id}>
                <CardHeader
                  icon={<ShieldAlert />}
                  title={who ? `Pay ${who} ${fmtUsdc(a.requestedMicro)}?` : `${humanize(d.kind)} — ${fmtUsdc(a.requestedMicro)}?`}
                  description={`Suggested by GrowTendril ${relTime(a.createdAt)}`}
                  action={
                    <>
                      <ModeBadge mode={d.dataMode} />
                      <StatusBadge status="pending" label="Waiting for you" />
                    </>
                  }
                />
                <div className="grid lg:grid-cols-[1fr_340px]">
                  <CardBody className="space-y-4">
                    <div>
                      <div className="text-[15px] font-semibold leading-snug text-ink">{a.title}</div>
                      <div className="num mt-1.5 text-[28px] font-medium leading-none tracking-[-0.03em]">
                        {fmtUsdc(a.requestedMicro, { unit: false })}
                        <span className="ml-1 text-[13px] text-ink-3">USDC</span>
                      </div>
                    </div>
                    <p className="rounded-[8px] bg-warning/[0.07] px-3 py-2 text-[13px] font-medium text-ink">{whyAsking(det.policy)}</p>
                    {det.rationale && <p className="text-[12.5px] leading-relaxed text-ink-2">{det.rationale}</p>}
                    {payee && <PayeePanel p={payee} />}
                    {det.delivery && <DeliveryPanel d={det.delivery} />}
                    {det.expectedOutcome && (
                      <div className="rounded-[8px] border border-line bg-bg/50 px-3 py-2 text-[12.5px]">
                        <span className="label mr-2">What it should bring</span>
                        <span className="text-ink">{det.expectedOutcome}</span>
                      </div>
                    )}
                    {det.reasons && det.reasons.length > 0 && (
                      <div>
                        <div className="label mb-1.5">Why now</div>
                        <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-2">
                          {det.reasons.map((r, ir) => (
                            <li key={`${ir}:${r}`} className="flex gap-2">
                              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                              {r}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {det.evidence && det.evidence.length > 0 && (
                      <div>
                        <div className="label mb-1.5">What people said</div>
                        <ul className="space-y-1 text-[12.5px]">
                          {det.evidence.map((e) => (
                            <li key={e.url + e.title}>
                              <a href={e.url} target={e.url.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-s1 hover:underline">
                                <span className="truncate">{e.title}</span>
                                <ArrowUpRight className="size-3 shrink-0" />
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardBody>
                  <div className="space-y-4 border-t border-line p-4 lg:border-l lg:border-t-0">
                    {det.confidence != null && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-ink-3">How sure GrowTendril is</span>
                        <Confidence value={det.confidence} />
                      </div>
                    )}
                    {(det.policy ?? []).length > 0 && (
                      <details>
                        <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">Details: the checks behind this</summary>
                        <ul className="mt-2 space-y-1.5">
                          {(det.policy ?? []).map((p) => (
                            <li key={p.rule} className="text-[12px] leading-snug">
                              <Badge tone="warn" className="num mr-1.5">
                                {p.rule}
                              </Badge>
                              <span className="text-ink-2">{p.detail}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="border-t border-line pt-4">
                      {canApprove ? (
                        <ApprovalControls id={a.id} requested={microToDecimal(a.requestedMicro)} payee={who} onchain={onchainSends.has(a.transactionId ?? "")} attribution={attribution} />
                      ) : (
                        <p className="flex items-center gap-2 text-[12px] text-ink-3">
                          <Lock className="size-3.5" /> An owner or admin decides this one.
                        </p>
                      )}
                    </div>
                    <Link href={`/app/receipts/${d.id}`} className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
                      Receipt <ArrowUpRight className="size-3" />
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<Inbox />} title="Nothing waiting for you" description="When GrowTendril wants to pay a creator or buy something above your limits, it shows up here with who, how much and why." />
      )}

      <Card>
        <CardHeader title="Decided" description="Every decision keeps its receipt, amount and note" icon={<CheckCircle2 />} />
        <DataTable
          columns={[
            { key: "title", label: "Payment" },
            { key: "decision", label: "No.", className: "w-20" },
            { key: "amount", label: "Amount", align: "right", sortable: true },
            { key: "status", label: "What you decided", sortable: true },
            { key: "note", label: "Note" },
            { key: "when", label: "When", sortable: true },
          ]}
          defaultSort={{ key: "when", dir: "desc" }}
          searchable={done.length > 8}
          rows={done.map(({ a, d }) => ({
            id: a.id,
            href: `/app/receipts/${d.id}`,
            cells: {
              title: <span className="block max-w-[340px] truncate">{a.title}</span>,
              decision: <span className="num text-ink-3">#{d.number}</span>,
              amount: (
                <span className="num">
                  {fmtUsdc(a.approvedMicro ?? a.requestedMicro)}
                  {a.approvedMicro != null && a.approvedMicro !== a.requestedMicro && <span className="ml-1 text-[11px] text-ink-4 line-through">{fmtUsdc(a.requestedMicro, { unit: false })}</span>}
                </span>
              ),
              status: (
                <span className="flex items-center gap-1.5">
                  <StatusBadge status={a.status} />
                  <ModeBadge mode={d.dataMode} />
                </span>
              ),
              note: <span className="block max-w-[260px] truncate text-ink-3">{a.note ?? "—"}</span>,
              when: <span className="whitespace-nowrap text-ink-3">{relTime(a.resolvedAt)}</span>,
            },
            sort: { amount: a.approvedMicro ?? a.requestedMicro, status: a.status, when: a.resolvedAt?.getTime() ?? 0 },
            search: `${a.title} ${a.status} ${a.note ?? ""} #${d.number}`,
          }))}
          empty={<p className="text-center text-[12.5px] text-ink-3">Nothing decided yet. Payments you say yes or no to are kept here with their receipts.</p>}
        />
      </Card>
    </div>
  );
}

async function payeesFor(db: Awaited<ReturnType<typeof requireProject>>["db"], projectId: string, userId: string, txIds: string[]): Promise<Map<string, Payee>> {
  const out = new Map<string, Payee>();
  if (!txIds.length) return out;
  const txs = await db.select().from(s.transactions).where(inArray(s.transactions.id, txIds));
  for (const tx of txs) {
    if (tx.kind !== "send" || !tx.recipient) continue;
    const ctx = await payeeContext(db, projectId, tx.recipient);
    let label: string | null = null;
    let now: string | null | undefined;
    if (tx.experimentId) {
      now = await currentPayee(db, tx.experimentId);
      const [row] = await db
        .select({ label: s.experiments.recipientLabel, handle: s.kols.handle })
        .from(s.experiments)
        .leftJoin(s.campaigns, eq(s.campaigns.experimentId, s.experiments.id))
        .leftJoin(s.kols, eq(s.campaigns.kolId, s.kols.id))
        .where(eq(s.experiments.id, tx.experimentId));
      label = row?.handle ? `@${row.handle}` : row?.label ?? null;
    }
    out.set(tx.id, { address: tx.recipient, label, ctx, changedTo: now?.toLowerCase() === tx.recipient.toLowerCase() ? undefined : now, hold: payeeHold(ctx, userId) });
  }
  return out;
}

function PayeePanel({ p }: { p: Payee }) {
  const recentChange = p.ctx.setBy?.replaced && Date.now() - p.ctx.setBy.at.getTime() < PAYEE_HOLD_MS;
  return (
    <div className="space-y-2 rounded-[8px] border border-line px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label flex items-center gap-1.5">
          <UserRoundCheck className="size-3.5" /> Pays {p.label ?? "this address"}
        </span>
        {p.ctx.firstPayment ? <Badge tone="warn">First payment to this address</Badge> : <Badge tone="good">Paid before · {relTime(p.ctx.lastPaidAt)}</Badge>}
      </div>
      <CopyField value={p.address} />
      {p.ctx.setBy && (
        <p className={recentChange ? "text-[12px] text-warning" : "text-[12px] text-ink-3"}>
          {p.ctx.setBy.replaced ? "Changed" : "Set"} {relTime(p.ctx.setBy.at)}
          {p.ctx.setBy.name ? ` by ${p.ctx.setBy.name}` : ""}
          {p.ctx.setBy.replaced ? ` (replaced ${p.ctx.setBy.replaced.slice(0, 6)}…${p.ctx.setBy.replaced.slice(-4)})` : ""}. Check the address with the person through a channel you already trust before you pay.
        </p>
      )}
      {p.changedTo !== undefined && (
        <Callout tone="danger" title="The address changed after this was suggested">
          The test now pays {p.changedTo ?? "no address"}. Choose “Don't pay”, then suggest the payment again so the new address gets its own check.
        </Callout>
      )}
      {p.hold && <Callout tone="warn">{p.hold}</Callout>}
    </div>
  );
}

function DeliveryPanel({ d }: { d: NonNullable<Details["delivery"]> }) {
  return (
    <div className="space-y-1.5 rounded-[8px] border border-line px-3 py-2.5 text-[12.5px]">
      <span className="label flex items-center gap-1.5">
        <PackageCheck className="size-3.5" /> The work is live
      </span>
      <a href={d.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 break-all text-s1 hover:underline">
        {d.url} <ArrowUpRight className="size-3 shrink-0" />
      </a>
      <p className="text-ink-2">
        Recorded {relTime(new Date(d.recordedAt))}
        {d.recordedBy ? ` by ${d.recordedBy}` : ""}. Since the first payment: <span className="num text-ink">{d.visits}</span> tracked visit{d.visits === 1 ? "" : "s"}, <span className="num text-ink">{d.conversions}</span> {d.successEvent.replace(/_/g, " ")} event{d.conversions === 1 ? "" : "s"}.
      </p>
      {d.visits === 0 && <p className="text-[12px] text-warning">No tracked visits yet — open the link and check the work is live and includes the tracked link.</p>}
    </div>
  );
}
