import { desc, eq } from "drizzle-orm";
import { FileCheck2 } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { schema as s } from "@/server/db/client";
import { fmtUsdc } from "@/lib/money";
import { relTime } from "@/lib/time";
import { Badge, Card, CardFooter, CardHeader, ModeBadge, PageHeader, Stat, StatStrip, TxStateBadge, VerdictBadge, shortHash } from "@/components/ui";
import { DataTable } from "@/components/ui/data-table";

type Body = { costMicro?: number | null; payment?: { state?: string } | null; autonomous?: boolean };
const humanize = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default async function Receipts() {
  const { project, db } = await requireProject();
  const rows = await db
    .select({ r: s.decisionReceipts, d: s.agentDecisions })
    .from(s.decisionReceipts)
    .innerJoin(s.agentDecisions, eq(s.decisionReceipts.decisionId, s.agentDecisions.id))
    .where(eq(s.decisionReceipts.projectId, project.id))
    .orderBy(desc(s.agentDecisions.number))
    .limit(500);

  const count = (v: string) => rows.filter((x) => x.d.policyVerdict === v).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Receipts"
        description="A receipt for everything GrowTendril did or asked to do: what, why, and who said yes. Each one is fingerprinted, so you can tell if it was ever changed."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            <span>{rows.length} receipts</span>
          </>
        }
      />

      <StatStrip className="grid-cols-2 lg:grid-cols-4">
        <Stat label="Receipts" value={rows.length} sub={`${rows.filter((x) => x.r.finalizedAt).length} finished`} />
        <Stat label="Done on its own" value={count("ALLOW")} sub="within your limits" tone={count("ALLOW") ? "good" : undefined} />
        <Stat label="Asked you first" value={count("APPROVAL_REQUIRED")} sub="waited for your OK" tone={count("APPROVAL_REQUIRED") ? "warn" : undefined} />
        <Stat label="Stopped" value={count("DENY")} sub="by one of your limits" tone={count("DENY") ? "bad" : undefined} />
      </StatStrip>

      <Card>
        <CardHeader title="All receipts" icon={<FileCheck2 />} />
        <DataTable
          searchable
          defaultSort={{ key: "number", dir: "desc" }}
          columns={[
            { key: "number", label: "No.", sortable: true, className: "w-20" },
            { key: "kind", label: "What", sortable: true },
            { key: "verdict", label: "Your limits", sortable: true },
            { key: "cost", label: "Amount", align: "right", sortable: true },
            { key: "state", label: "Result" },
            { key: "when", label: "When", sortable: true },
          ]}
          rows={rows.map(({ r, d }) => {
            const b = r.body as Body;
            const cost = b.costMicro ?? null;
            return {
              id: r.id,
              href: `/app/receipts/${d.id}`,
              cells: {
                number: <span className="num">#{d.number}</span>,
                kind: (
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    {humanize(d.kind)}
                    {!d.autonomous && <Badge tone="muted">asked you</Badge>}
                  </span>
                ),
                verdict: <VerdictBadge verdict={d.policyVerdict} />,
                cost: <span className="num">{cost != null ? fmtUsdc(cost) : <span className="text-ink-4">—</span>}</span>,
                state: b.payment?.state ? <TxStateBadge state={b.payment.state} /> : <span className="text-[11.5px] text-ink-3">{humanize(d.status)}</span>,

                when: (
                  <span className="whitespace-nowrap text-ink-3" title={d.createdAt.toISOString()}>
                    {relTime(d.createdAt)}
                  </span>
                ),
              },
              sort: { number: d.number, kind: d.kind, agent: d.agent, verdict: d.policyVerdict ?? "", cost, mode: d.dataMode, when: d.createdAt.getTime() },
              search: `#${d.number} ${d.kind} ${d.agent} ${d.policyVerdict ?? ""} ${d.dataMode} ${r.digest} ${d.rationale}`,
            };
          })}
          empty={<p className="text-center text-[12.5px] text-ink-3">No receipts yet. Everything GrowTendril does — buying research, suggesting a payment, moving budget between tests — leaves one. Scan for customers to start.</p>}
        />
        <CardFooter>Open a receipt to see its proof. If its fingerprint doesn&apos;t match, the record was changed after it was written.</CardFooter>
      </Card>
    </div>
  );
}
