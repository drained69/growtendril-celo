import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Braces, CheckCircle2, FileCheck2, Fingerprint, Lightbulb, Route, ShieldCheck, XCircle } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { schema as s } from "@/server/db/client";
import { canonicalJson, sha256 } from "@/server/lib/ids";
import { txExplorerUrl } from "@/server/integrations/celo/config";
import { fmtUsdc } from "@/lib/money";
import { Badge, Callout, Card, CardBody, CardHeader, ExternalLink, KeyValue, LinkButton, ModeBadge, PageHeader, StatusBadge, TxStateBadge, VerdictBadge, shortHash } from "@/components/ui";
import { CopyField } from "@/components/ui/copy";
import { writeReceipt } from "@/server/domain/agent/decisions";
import { RAIL_LABEL } from "@/lib/rails";

type Body = {
  decision: number;
  agent: string;
  action: string;
  structuredAction: Record<string, unknown>;
  service: { vendor: string; source: string; resource: string } | null;
  costMicro: number | null;
  why: { rationale: string; reasons: string[] };
  policy: { verdict: string; checks: { rule: string; passed: boolean; detail: string }[] } | null;
  approval: { status: string; resolvedAt: string | null; approvedMicro: number | null; note: string | null } | null;
  status: string;
  autonomous: boolean;
  result: Record<string, unknown> | null;
  confidence: { before: number; after: number | null } | null;
  payment: { rail: string; network: string; destination: string | null; state: string; settlementId: string | null; settlementStatus: string | null; chainCheck?: string | null; txHash: string | null; batchTxHash: string | null; explorerUrl: string | null; responseDigest: string | null; trail: { from: string | null; to: string; at: string; note: string | null }[] } | null;
  dataMode: string;
  createdAt: string;
};

const RAIL = RAIL_LABEL;
const humanize = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const NETWORK_KEY: Record<string, string> = { "Celo Mainnet": "Celo", "Base Sepolia": "Base_Sepolia", "Arbitrum Sepolia": "Arbitrum_Sepolia", "Ethereum Sepolia": "Ethereum_Sepolia" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { project, db } = await requireProject();
  let [r] = await db.select().from(s.decisionReceipts).where(and(eq(s.decisionReceipts.decisionId, id), eq(s.decisionReceipts.projectId, project.id)));
  if (!r) notFound();
  if (sha256(canonicalJson(r.body)) === r.digest) {
    const [tx] = await db.select().from(s.transactions).where(and(eq(s.transactions.projectId, project.id), eq(s.transactions.decisionId, id)));
    const payment = (r.body as { payment?: { state?: string; chainCheck?: string | null } }).payment;
    if (tx && (payment?.state !== tx.state || (payment.chainCheck ?? null) !== (tx.chainCheck ?? null))) {
      await writeReceipt(db, id);
      [r] = await db.select().from(s.decisionReceipts).where(and(eq(s.decisionReceipts.decisionId, id), eq(s.decisionReceipts.projectId, project.id)));
    }
  }
  if (!r) notFound();
  const b = r.body as unknown as Body;
  const intact = sha256(canonicalJson(r.body)) === r.digest;
  const status = b.payment?.state ?? b.status;
  const p = b.payment;
  const chainKey = p ? (NETWORK_KEY[p.network] ?? p.network) : "Celo";
  const txUrl = p?.txHash ? (p.explorerUrl ?? txExplorerUrl(chainKey, p.txHash)) : null;
  const passed = b.policy?.checks.filter((c) => c.passed).length ?? 0;

  const plain = plainSentence(b, status);
  const who = b.autonomous ? "GrowTendril did this on its own, within your limits." : b.approval ? (b.approval.status === "approved" ? "You (or a teammate) said yes." : b.approval.status === "rejected" ? "You (or a teammate) said no." : "Waiting for your OK.") : "Started by your team.";

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[
          { label: "Receipts", href: "/app/receipts" },
          { label: `#${b.decision}`, href: `/app/receipts/${id}` },
        ]}
        title={plain}
        description={b.why.rationale}
        meta={
          <>
            <ModeBadge mode={b.dataMode} />
            {b.payment ? <TxStateBadge state={status} /> : <StatusBadge status={status} />}
            <span className="num">{b.createdAt.replace("T", " ").slice(0, 16)} UTC</span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2"><LinkButton href={`/api/receipts/${id}`}>Download receipt</LinkButton>
          <Badge tone={intact ? "good" : "bad"} className="h-6 px-2 text-[11.5px]">
            {intact ? <ShieldCheck className="size-3.5" /> : <XCircle className="size-3.5" />}
            {intact ? "Unchanged since it was written" : "Changed after it was written"}
          </Badge></div>
        }
      />

      {!intact && (
        <Callout tone="danger" title="This receipt was changed after it was written">
          Its fingerprint no longer matches the one saved when it was written, so don&apos;t rely on what it says.
        </Callout>
      )}

      <Card>
        <CardHeader title="What happened" icon={<FileCheck2 />} />
        <CardBody className="space-y-4">
          <p className="text-[14px] leading-relaxed text-ink">{plain} {who}</p>
          <KeyValue
            items={[
              ...(b.costMicro != null ? [{ k: "Amount", v: <span className="num">{fmtUsdc(b.costMicro)}</span> }] : []),
              ...(b.approval?.approvedMicro != null ? [{ k: "Amount you approved", v: <span className="num">{fmtUsdc(b.approval.approvedMicro)}</span> }] : []),
              ...(b.service ? [{ k: "Bought from", v: b.service.vendor }] : []),
              { k: "Status", v: b.payment ? <TxStateBadge state={status} /> : <StatusBadge status={status} /> },
              ...(p?.chainCheck ? [{ k: "Checked on Celo", v: p.chainCheck === "verified" ? "Yes — the right amount reached the right person" : p.chainCheck }] : []),
              ...(txUrl ? [{ k: "Public proof", v: <ExternalLink href={txUrl}>See it on Celoscan</ExternalLink> }] : []),
              ...(b.approval?.note ? [{ k: "Your note", v: <span className="text-ink-2">{b.approval.note}</span> }] : []),
              ...(b.result && "summary" in b.result ? [{ k: "Result", v: <span className="text-ink-2">{String(b.result.summary)}</span> }] : []),
            ]}
          />
          {status === "SIMULATED" && (
            <Callout tone="warn" title="Practice run">
              No Payout account was set up, so no money moved. Set one up on the Payout account page to do this for real.
            </Callout>
          )}
        </CardBody>
      </Card>

      {b.why.reasons.length > 0 && (
        <Card>
          <CardHeader title="Why" icon={<Lightbulb />} />
          <CardBody>
            <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-2">
              {b.why.reasons.map((x, ix) => (
                <li key={`${ix}:${x}`} className="flex gap-2">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                  {x}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <details className="group rounded-[14px] border border-line bg-surface">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-[13px] font-medium text-ink"><Fingerprint className="size-4 text-ink-3" /> Proof / technical details</summary>
        <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Receipt" icon={<FileCheck2 />} />
              <CardBody>
                <KeyValue
                  items={[
                    { k: "Action", v: `${humanize(b.action)} · decision #${b.decision} by the ${b.agent} agent` },
                    ...(b.service ? [{ k: "Service", v: <span>{b.service.vendor} <span className="text-ink-3">({b.service.source === "circle_marketplace" ? "Celo research catalog" : "bundled x402 seller"})</span></span> }] : []),
                    ...(b.service?.resource ? [{ k: "Resource", v: <span className="num block max-w-[420px] truncate text-[11.5px] text-ink-2">{b.service.resource}</span> }] : []),
                    { k: "Autonomy", v: b.autonomous ? "Autonomously approved by policy" : b.approval ? `Founder ${b.approval.status}` : "Human-initiated" },
                    ...(b.confidence ? [{ k: "Confidence", v: <span className="num">{Math.round(b.confidence.before * 100)}% → {b.confidence.after != null ? `${Math.round(b.confidence.after * 100)}%` : "…"}</span> }] : []),
                  ]}
                />
              </CardBody>
            </Card>
            {b.policy && (
              <Card>
                <CardHeader title="Limits checked" description={`${passed} of ${b.policy.checks.length} checks passed`} icon={<ShieldCheck />} action={<VerdictBadge verdict={b.policy.verdict} />} />
                <ul className="divide-y divide-line">
                  {b.policy.checks.map((c) => (
                    <li key={c.rule} className="grid grid-cols-[16px_minmax(0,200px)_1fr] items-start gap-3 px-4 py-2 text-[12px]">
                      {c.passed ? <CheckCircle2 className="mt-px size-3.5 text-good" /> : <XCircle className="mt-px size-3.5 text-warning" />}
                      <span className="num truncate text-ink">{c.rule}</span>
                      <span className="text-ink-3">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Card>
              <CardHeader title="Request as checked" description="The exact request checked against your limits" icon={<Braces />} />
              <CardBody>
                <pre className="num overflow-x-auto rounded-[8px] border border-line bg-bg px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-2">{JSON.stringify(b.structuredAction, null, 2)}</pre>
              </CardBody>
            </Card>
          </div>
          <div className="space-y-4">
            {p && (
              <Card>
                <CardHeader title="Payment trace" icon={<Route />} action={<TxStateBadge state={p.state} />} />
                <CardBody className="space-y-4">
                  <KeyValue
                    items={[
                      { k: "Rail", v: RAIL[p.rail] ?? p.rail },
                      { k: "Network", v: `${p.network}${p.destination ? ` → ${p.destination}` : ""}` },
                      { k: "Settlement ID", v: p.settlementId ? <span className="num text-[11.5px]" title={p.settlementId}>{shortHash(p.settlementId, 6)}</span> : "—" },
                      { k: "Settlement status", v: p.settlementStatus ?? "—" },
                      { k: "Tx hash", v: p.txHash && txUrl ? <ExternalLink href={txUrl} className="num text-[11.5px]">{shortHash(p.txHash)}</ExternalLink> : "—" },
                      { k: "Celo batch tx", v: p.batchTxHash ? <ExternalLink href={txExplorerUrl(chainKey, p.batchTxHash)} className="num text-[11.5px]">{shortHash(p.batchTxHash)}</ExternalLink> : "—" },
                      ...(p.responseDigest ? [{ k: "Response sha256", v: <span className="num text-[11px]" title={p.responseDigest}>{shortHash(p.responseDigest, 8)}</span> }] : []),
                    ]}
                  />
                  {p.trail.length > 0 && (
                    <div>
                      <div className="label mb-2">State machine</div>
                      <ol className="relative space-y-2.5 border-l border-line pl-4">
                        {p.trail.map((t, i) => (
                          <li key={i} className="relative text-[12px]">
                            <span className={`absolute -left-[20.5px] top-[5px] size-2 rounded-full ring-2 ring-surface ${i === p.trail.length - 1 ? "bg-s1" : "bg-ink-4"}`} />
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="num text-ink">
                                <span className="text-ink-3">{t.from ?? "∅"}</span> → {t.to}
                              </span>
                              <span className="num text-[11px] text-ink-4">{t.at.slice(11, 19)}</span>
                            </div>
                            {t.note && <div className="mt-0.5 text-[11.5px] text-ink-3">{t.note}</div>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}
            <Card>
              <CardHeader title="Fingerprint (sha256)" description="Worked out again every time you open this receipt" icon={<Fingerprint />} action={<Badge tone={intact ? "good" : "bad"}>{intact ? "Matches" : "Doesn't match"}</Badge>} />
              <CardBody className="space-y-2">
                <CopyField value={r.digest} />
                <p className="text-[11.5px] text-ink-3">{r.finalizedAt ? "Final — the payment is finished." : "Still open — the receipt is updated as the payment moves."}</p>
              </CardBody>
            </Card>
          </div>
        </div>
      </details>
    </div>
  );
}

/** One plain sentence for what this receipt records. */
function plainSentence(b: Body, status: string): string {
  const amount = b.costMicro != null ? fmtUsdc(b.costMicro) : null;
  const to = typeof b.structuredAction.recipient === "string" ? shortHash(b.structuredAction.recipient as string, 4) : b.payment?.destination ?? null;
  if (b.action === "send_payment") {
    const what = `${amount ?? "a payment"}${to ? ` to ${to}` : ""}`;
    if (status === "SETTLED") return `Paid ${what}.`;
    if (status === "AWAITING_APPROVAL") return `Waiting for your OK to pay ${what}.`;
    if (status === "REJECTED") return `You chose not to pay ${what}.`;
    if (status === "DENIED") return `Not paid: your limits stopped a payment of ${what}.`;
    if (status === "FAILED") return `A payment of ${what} didn't go through.`;
    if (status === "SIMULATED") return `Practice payment of ${what} — no money moved.`;
    return `Paying ${what}.`;
  }
  if (b.action === "purchase_service") return `${status === "SETTLED" ? "Bought" : status === "DENIED" ? "Didn't buy" : "Buying"} research${b.service ? ` from ${b.service.vendor}` : ""}${amount ? ` for ${amount}` : ""}.`;
  if (b.action === "create_experiment") return "Suggested a new test.";
  if (b.action === "reallocate_budget") return `Moved ${amount ?? "budget"} between tests.`;
  return `${humanize(b.action)}.`;
}
