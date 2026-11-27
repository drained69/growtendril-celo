import { desc, eq } from "drizzle-orm";
import { Brain, FlaskConical, Play, Radar } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { activeMission, missionSummary } from "@/server/queries/missions";
import { runLearningAction } from "@/server/actions/growth";
import { fmtUsdc } from "@/lib/money";
import { Badge, Card, CardFooter, CardHeader, EmptyState, LinkButton, ModeBadge, PageHeader, Stat, StatStrip, StatusBadge } from "@/components/ui";
import { DataTable } from "@/components/ui/data-table";
import { ActionButton } from "@/components/features/agent/action-button";

const CHANNEL_LABEL: Record<string, string> = { kol: "Creator", content: "Content", bounty: "Bounty", community: "Community", creator_program: "Campaign" };
const VERDICT_TONE = (v: string) => (v === "SCALE" ? "good" : v === "STOP" || v === "REDUCE" ? "bad" : "neutral") as "good" | "bad" | "neutral";

export default async function Experiments() {
  const { project, role, db } = await requireProject();
  const operate = can(role, "operate");
  const [exps, mission] = await Promise.all([db.select().from(s.experiments).where(eq(s.experiments.projectId, project.id)).orderBy(desc(s.experiments.number)), activeMission(db, project.id)]);
  const sum = mission ? await missionSummary(db, mission) : null;
  const perf = new Map(sum?.perf.map((p) => [p.experimentId, p]) ?? []);
  const finding = new Map(sum?.findings.map((f) => [f.experimentId, f]) ?? []);
  const running = exps.filter((x) => x.status === "running").length;
  const spent = sum?.perf.reduce((n, p) => n + p.spentMicro, 0) ?? 0;
  const conversions = sum?.perf.reduce((n, p) => n + p.conversions, 0) ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tests"
        description="Small paid tests, such as a creator post or a bounty. Each one says what it should achieve and how it's paid, and we ask before paying anyone. Results are counted through each test's tracked link or code."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            {mission ? <span>Goal: {mission.name}</span> : <span>No goal yet</span>}
          </>
        }
        actions={<><LinkButton href="/app/experiments/start" variant="primary" icon={<FlaskConical />}>Start a test</LinkButton>{operate && mission && <ActionButton action={runLearningAction} label="Compare results" icon={<Brain />} logTitle="Compare results" />}</>}
      />

      <StatStrip className="grid-cols-2 lg:grid-cols-4">
        <Stat label="Tests" value={exps.length} sub={`${exps.filter((x) => x.status === "proposed").length} not started`} />
        <Stat label="Running" value={running} sub="started and paying" />
        <Stat label="Spent" value={fmtUsdc(spent, { unit: false })} sub="USDC, this month" />
        <Stat label="Results" value={conversions} sub={spent && conversions ? `${fmtUsdc(Math.round(spent / conversions), { unit: false })} USDC each` : "counted through tracked links"} />
      </StatStrip>

      {exps.length ? (
        <Card>
          <CardHeader title="All tests" icon={<FlaskConical />} />
          <DataTable
            searchable
            defaultSort={{ key: "number", dir: "desc" }}
            columns={[
              { key: "title", label: "Test" },
              { key: "channel", label: "Type", sortable: true },
              { key: "budget", label: "Budget", align: "right", sortable: true },
              { key: "spent", label: "Spent", align: "right", sortable: true },
              { key: "visits", label: "Visits", align: "right", sortable: true },
              { key: "conv", label: "Results", align: "right", sortable: true },
              { key: "cpa", label: "Cost each", align: "right", sortable: true },
              { key: "stop", label: "How it's paid" },
              { key: "verdict", label: "What we learned", sortable: true },
              { key: "status", label: "Status", sortable: true },
              { key: "act", label: "" },
            ]}
            rows={exps.map((x) => {
              const p = perf.get(x.id);
              const f = finding.get(x.id);
              return {
                id: x.id,
                href: `/app/experiments/${x.id}`,
                cells: {
                  title: (
                    <span className="block max-w-[340px]">
                      <span className="flex items-center gap-1.5">
                        <span className="num font-normal text-ink-4">#{x.number}</span>
                        <span className="truncate">{x.title}</span>
                      </span>
                      <span className="block truncate text-[11.5px] font-normal text-ink-3">{x.hypothesis}</span>
                    </span>
                  ),
                  channel: <Badge tone="muted">{CHANNEL_LABEL[x.channel] ?? x.channel}</Badge>,
                  budget: <span className="num">{fmtUsdc(x.budgetMicro, { unit: false })}</span>,
                  spent: <span className="num">{p ? fmtUsdc(p.spentMicro, { unit: false }) : "—"}</span>,
                  visits: <span className="num text-ink-2">{p?.visits ?? "—"}</span>,
                  conv: <span className="num">{p?.conversions ?? "—"}</span>,
                  cpa: <span className="num">{f?.cpaMicro != null ? fmtUsdc(f.cpaMicro, { unit: false }) : "—"}</span>,
                  stop: (
                    <span className="whitespace-nowrap text-[11.5px] text-ink-3">
                      {x.stopAfterSpendMicro >= x.budgetMicro ? "One payment" : "Half now, half when live"}
                    </span>
                  ),
                  verdict: f ? <Badge tone={VERDICT_TONE(f.verdict)}>{f.verdict.replace(/_/g, " ")}</Badge> : <span className="text-ink-4">—</span>,
                  status: (
                    <span className="flex items-center gap-1.5">
                      <StatusBadge status={x.status} />
                      <ModeBadge mode={x.dataMode} />
                    </span>
                  ),
                  act: operate && x.status === "proposed" ? <LinkButton href={`/app/experiments/${x.id}`} size="xs" icon={<Play />}>Review and launch</LinkButton> : null,
                },
                sort: { number: x.number, channel: x.channel, budget: x.budgetMicro, spent: p?.spentMicro ?? null, visits: p?.visits ?? null, conv: p?.conversions ?? null, cpa: f?.cpaMicro ?? null, verdict: f?.verdict ?? null, status: x.status },
                search: `#${x.number} ${x.title} ${x.hypothesis} ${x.channel} ${x.status} ${f?.verdict ?? ""}`,
              };
            })}
          />
          <CardFooter>Spend and results are for this month. Cost each = money paid ÷ results counted.</CardFooter>
        </Card>
      ) : (
        <EmptyState
          icon={<FlaskConical />}
          title="No tests yet"
          description="GrowTendril suggests a test when it finds a strong opportunity. You can also start one yourself from any opportunity."
          action={<LinkButton href="/app/experiments/start" variant="primary" icon={<Radar />}>Start a test</LinkButton>}
        />
      )}
    </div>
  );
}
