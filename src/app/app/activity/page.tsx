import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ArrowRight, Bot, Receipt, RefreshCw, Workflow } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { schema as s } from "@/server/db/client";
import { recentDecisions, recentTransactions } from "@/server/queries/activity";
import { CHAINS, txExplorerUrl } from "@/server/integrations/celo/config";
import { refreshSettlementsAction } from "@/server/actions/wallet";
import { fmtUsdc } from "@/lib/money";
import { relTime } from "@/lib/time";
import { Badge, Card, CardFooter, CardHeader, ExternalLink, ModeBadge, PageHeader, Stat, StatStrip, StatusBadge, TxStateBadge, VerdictBadge, shortHash } from "@/components/ui";
import { DataTable } from "@/components/ui/data-table";
import { ActionButton } from "@/components/features/agent/action-button";
import { ChainCheckBadge } from "@/components/features/wallet/chain-check-badge";
import { RAIL_AUTH, RAIL_LABEL } from "@/lib/rails";

const RAIL = RAIL_LABEL;
const AUTH = RAIL_AUTH;
const humanize = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default async function Activity() {
  const { project, db } = await requireProject();
  const pid = project.id;
  const [txs, purchases, decisions, runs] = await Promise.all([
    recentTransactions(db, pid, 200),
    db
      .select({ p: s.x402Purchases, txId: s.transactions.id })
      .from(s.x402Purchases)
      .innerJoin(s.transactions, eq(s.x402Purchases.transactionId, s.transactions.id))
      .where(eq(s.transactions.projectId, pid))
      .orderBy(desc(s.x402Purchases.createdAt)),
    recentDecisions(db, pid, 200),
    db.select().from(s.agentRuns).where(eq(s.agentRuns.projectId, pid)).orderBy(desc(s.agentRuns.startedAt)).limit(5),
  ]);
  const purchaseByTx = new Map(purchases.map((p) => [p.txId, p.p]));
  const real = txs.filter((t) => t.dataMode === "TESTNET" || t.dataMode === "LIVE");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="Every payment GrowTendril proposed, its approval, state, Celo settlement reference and Celo transaction hash."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            <span>
              {txs.length} payment{txs.length === 1 ? "" : "s"} · {decisions.length} decision{decisions.length === 1 ? "" : "s"}
            </span>
          </>
        }
        actions={<ActionButton action={refreshSettlementsAction} label="Refresh settlements" icon={<RefreshCw />} />}
      />

      <StatStrip className="grid-cols-2 lg:grid-cols-4">
        <Stat label="x402 purchases" value={purchases.length} sub="paid API calls" />
        <Stat label="x402 settlements" value={txs.filter((t) => t.settlementId).length} sub="with a Celo transaction" />
        <Stat label="Celo transfers" value={txs.filter((t) => t.rail === "celo_usdc_send" && t.txHash).length} sub="Celo wallet Send with tx hash" />
        <Stat label="On-chain payments" value={real.length} sub={`of ${txs.length} payment rows`} />
      </StatStrip>

      <Card>
        <CardHeader title="Payment trace" description="Creator payouts and paid research on Celo, each checked against the chain" icon={<Receipt />} />
        <DataTable
          searchable
          defaultSort={{ key: "when", dir: "desc" }}
          columns={[
            { key: "when", label: "When", sortable: true },
            { key: "rail", label: "Rail", sortable: true },
            { key: "request", label: "Request" },
            { key: "amount", label: "Amount", align: "right", sortable: true },
            { key: "auth", label: "Authorization" },
            { key: "settlement", label: "Settlement" },
            { key: "state", label: "State", sortable: true },
            { key: "tx", label: "Celo tx / batch" },
            { key: "receipt", label: "" },
          ]}
          rows={txs.map((t) => {
            const purchase = purchaseByTx.get(t.id);
            const request = purchase
              ? purchase.purpose
              : t.kind === "bridge"
                ? `${CHAINS[t.chain]?.label ?? t.chain} → ${CHAINS[t.destChain ?? ""]?.label ?? t.destChain ?? "—"}`
                : t.recipient
                    ? `to ${shortHash(t.recipient, 4)}`
                    : humanize(t.kind);
            return {
              id: t.id,
              cells: {
                when: (
                  <span className="whitespace-nowrap text-ink-3" title={t.createdAt.toISOString()}>
                    {relTime(t.createdAt)}
                  </span>
                ),
                rail: <span className="whitespace-nowrap">{RAIL[t.rail] ?? t.rail}</span>,
                request: (
                  <span className="block max-w-[260px] truncate text-ink-2" title={purchase?.resourceUrl ?? t.recipient ?? ""}>
                    {request}
                  </span>
                ),
                amount: <span className="num whitespace-nowrap">{fmtUsdc(t.amountMicro)}</span>,
                auth: <span className="whitespace-nowrap text-[11.5px] text-ink-3">{AUTH[t.rail] ?? "—"}</span>,
                settlement: t.settlementId ? (
                  <span className="num text-[11.5px]">
                    {shortHash(t.settlementId, 4)}
                    {t.settlementStatus && <span className="block text-ink-3">{t.settlementStatus}</span>}
                  </span>
                ) : (
                  <span className="text-ink-4">—</span>
                ),
                state: (
                  <span className="flex items-center gap-1">
                    <TxStateBadge state={t.state} />
                    {t.dataMode !== t.state && <ModeBadge mode={t.dataMode} />}
                    <ChainCheckBadge check={t.chainCheck} />
                  </span>
                ),
                tx: t.batchTxHash ? (
                  <ExternalLink href={txExplorerUrl(t.chain, t.batchTxHash)} className="num whitespace-nowrap text-[11.5px]">
                    batch {shortHash(t.batchTxHash, 4)}
                  </ExternalLink>
                ) : t.txHash ? (
                  <ExternalLink href={t.explorerUrl ?? txExplorerUrl(t.chain, t.txHash)} className="num whitespace-nowrap text-[11.5px]">
                    {shortHash(t.txHash, 4)}
                  </ExternalLink>
                ) : t.error ? (
                  <span className="block max-w-[180px] truncate text-[11.5px] text-critical" title={t.error}>
                    {t.error}
                  </span>
                ) : (
                  <span className="text-ink-4">—</span>
                ),
                receipt: (
                  <Link href={`/app/receipts/${t.decisionId}`} className="text-[11.5px] text-ink-3 hover:text-ink">
                    Receipt →
                  </Link>
                ),
              },
              sort: { when: t.createdAt.getTime(), rail: t.rail, amount: t.amountMicro, state: t.state },
              search: `${RAIL[t.rail] ?? t.rail} ${request} ${t.state} ${t.dataMode} ${t.txHash ?? ""} ${t.settlementId ?? ""}`,
            };
          })}
          empty={<p className="text-center text-[12.5px] text-ink-3">No payments yet. They appear when the agent buys data over x402 or you approve a creator payment.</p>}
        />
        <CardFooter className="block leading-relaxed">
          Celo x402 lifecycle: the agent signs an exact USDC authorization, the facilitator submits a transfer, and GrowTendril checks the onchain payer, recipient and amount before marking the payment settled.
        </CardFooter>
      </Card>

      <Card id="decisions" className="scroll-mt-4">
        <CardHeader title="Agent decisions" description="Each decision has a hashed receipt with its rationale and policy checks" icon={<Bot />} action={<Link href="/app/receipts" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">Receipts <ArrowRight className="size-3" /></Link>} />
        <DataTable
          searchable
          defaultSort={{ key: "number", dir: "desc" }}
          columns={[
            { key: "number", label: "#", sortable: true, className: "w-14" },
            { key: "when", label: "When", sortable: true },
            { key: "agent", label: "Agent", sortable: true },
            { key: "kind", label: "Decision", sortable: true },
            { key: "rationale", label: "Rationale" },
            { key: "verdict", label: "Policy", sortable: true },
            { key: "mode", label: "Mode" },
          ]}
          rows={decisions.map((d) => ({
            id: d.id,
            href: `/app/receipts/${d.id}`,
            cells: {
              number: <span className="num">#{d.number}</span>,
              when: (
                <span className="whitespace-nowrap text-ink-3" title={d.createdAt.toISOString()}>
                  {relTime(d.createdAt)}
                </span>
              ),
              agent: <span className="text-ink-2">{d.agent}</span>,
              kind: (
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  {humanize(d.kind)}
                  {!d.autonomous && <Badge tone="muted">human</Badge>}
                </span>
              ),
              rationale: <span className="block max-w-[440px] truncate text-ink-3" title={d.rationale}>{d.rationale}</span>,
              verdict: <VerdictBadge verdict={d.policyVerdict} />,
              mode: <ModeBadge mode={d.dataMode} />,
            },
            sort: { number: d.number, when: d.createdAt.getTime(), agent: d.agent, kind: d.kind, verdict: d.policyVerdict ?? "" },
            search: `#${d.number} ${d.agent} ${d.kind} ${d.rationale} ${d.policyVerdict ?? ""}`,
          }))}
          empty={<p className="text-center text-[12.5px] text-ink-3">No decisions yet — run a cycle to let the agents evaluate opportunities.</p>}
        />
      </Card>

      <Card>
        <CardHeader title="Recent operator runs" icon={<Workflow />} action={<Link href="/app/runs" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">Agent runs <ArrowRight className="size-3" /></Link>} />
        {runs.length ? (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12.5px]">
                <span className="text-ink-2">
                  <span className="text-ink">{humanize(r.trigger)} run</span> · <span className="num">{r.log.length}</span> steps
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="w-16 text-right text-[11.5px] text-ink-4">{relTime(r.startedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">No agent runs yet. Start one with “Run agent” or turn on autopilot in Settings.</p>
        )}
      </Card>
    </div>
  );
}
