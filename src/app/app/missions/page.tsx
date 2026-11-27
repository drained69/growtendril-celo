import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ArrowRight, Brain, Flag, Plus } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { missionSummary, CATEGORY_LABEL } from "@/server/queries/missions";
import { runLearningAction } from "@/server/actions/growth";
import { EVENT_LABEL, type ConversionEventType } from "@/server/domain/growth/attribution-links";
import { fmtUsdc } from "@/lib/money";
import { isoDate, relTime } from "@/lib/time";
import { Badge, Card, CardBody, CardFooter, CardHeader, EmptyState, LinkButton, ModeBadge, PageHeader, Stat, StatusBadge, Table } from "@/components/ui";
import { GoalProgress, StackedBar } from "@/components/charts";
import { ActionButton } from "@/components/features/agent/action-button";

type Finding = { label: string; verdict: string; reason: string };
type Realloc = { amountMicro: number; reason: string };
const VERDICT_TONE = (v: string) => (v === "SCALE" ? "good" : v === "STOP" || v === "REDUCE" ? "bad" : "neutral") as "good" | "bad" | "neutral";

export default async function Missions() {
  const { project, role, db } = await requireProject();
  const operate = can(role, "operate");
  const [missions, learnings] = await Promise.all([
    db.select().from(s.missions).where(eq(s.missions.projectId, project.id)).orderBy(desc(s.missions.createdAt)),
    db.select().from(s.learnings).where(eq(s.learnings.projectId, project.id)).orderBy(desc(s.learnings.createdAt)).limit(5),
  ]);
  const summaries = await Promise.all(missions.map((m) => missionSummary(db, m)));
  const hasActive = missions.some((m) => m.status === "active");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Goal"
        description="What you want more of, with a monthly budget that starts again every 30 days. Results are counted, never estimated."
        meta={
          <>
            <ModeBadge mode={project.dataMode} />
            <span>
              {missions.length} month{missions.length === 1 ? "" : "s"} so far
            </span>
          </>
        }
        actions={
          <>
            {operate && hasActive && <ActionButton action={runLearningAction} label="Compare results" icon={<Brain />} logTitle="Compare results" />}
            {operate && (
              <LinkButton href="/onboarding?step=3" icon={<Plus />} variant="primary">
                New goal
              </LinkButton>
            )}
          </>
        }
      />

      {!missions.length && (
        <EmptyState
          icon={<Flag />}
          title="No goal yet"
          description="Set what you want more of and a monthly budget. Nothing is spent without one."
          action={operate ? <LinkButton href="/onboarding?step=3" variant="primary" icon={<Plus />}>Set a goal</LinkButton> : undefined}
        />
      )}

      {missions.map((m, i) => {
        const sum = summaries[i];
        const pct = Math.round((sum.achieved / Math.max(1, m.goalTarget)) * 100);
        return (
          <Card key={m.id}>
            <CardHeader
              icon={<Flag />}
              title={m.name}
              description={m.goalDescription}
              action={
                <>
                  <ModeBadge mode={m.dataMode} />
                  <StatusBadge status={m.status} label={m.status === "active" ? "This month" : m.status === "closing" ? "Finishing its tests" : m.status === "completed" ? "Done" : undefined} />
                  <span className="num hidden text-[11.5px] text-ink-3 sm:inline">
                    {isoDate(m.startsAt)} → {isoDate(m.endsAt)}
                  </span>
                </>
              }
            />
            <div className="grid lg:grid-cols-[1.25fr_1fr]">
              <CardBody className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="text-[11.5px] font-medium text-ink-3">{EVENT_LABEL[m.goalEvent as ConversionEventType] ?? m.goalEvent}</div>
                    <div className="num mt-1 text-[30px] font-medium leading-none tracking-[-0.03em]">
                      {sum.achieved}
                      <span className="text-[15px] text-ink-3"> / {m.goalTarget}</span>
                    </div>
                  </div>
                  <div className="text-right text-[11.5px] text-ink-3">
                    <div className="num text-[13px] text-ink">{pct}%</div>
                    {m.status === "active" ? `${sum.daysLeft} days until it resets · on pace for ${Math.round(sum.pace)}` : "final"}
                  </div>
                </div>
                <GoalProgress achieved={sum.achieved} goal={m.goalTarget} pace={m.status === "active" ? sum.pace : undefined} />
                <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                  <Stat size="sm" label="From tests" value={sum.attributed} sub="counted through tracked links" />
                  <Stat size="sm" label="Monthly budget" value={fmtUsdc(m.budgetMicro, { unit: false })} sub="USDC" />
                  <Stat size="sm" label="Spent" value={fmtUsdc(sum.spent, { unit: false })} sub="paid or being paid" />
                  <Stat size="sm" label="Cost each" value={sum.costPerQualified ? fmtUsdc(sum.costPerQualified, { unit: false }) : "—"} sub="USDC per result" />
                  <Stat size="sm" label="Tests" value={sum.experiments} sub={`${sum.successful} worked`} />
                  <Stat size="sm" label="Set aside" value={fmtUsdc(sum.committed, { unit: false })} sub="for running tests" />
                  <Stat size="sm" label="Left" value={fmtUsdc(sum.available, { unit: false })} tone="good" sub="for new tests" />
                  <Stat size="sm" label="Overall score" value={`${sum.efficiency}/100`} sub="goal, cost and hit rate" />
                </div>
              </CardBody>
              <div className="border-t border-line lg:border-l lg:border-t-0">
                <div className="px-4 pb-3 pt-4">
                  <div className="label mb-2">Spent by type</div>
                  {sum.allocation.some((a) => a.used > 0) ? <StackedBar total={Math.max(1, sum.allocation.reduce((n, a) => n + a.used, 0))} parts={sum.allocation.filter((a) => a.used > 0).map((a) => ({ key: a.category, label: CATEGORY_LABEL[a.category] ?? a.category, value: a.used, display: fmtUsdc(a.used, { unit: false }) }))} /> : <p className="text-[12.5px] text-ink-3">Nothing spent yet this month.</p>}
                </div>
                {sum.allocation.some((a) => a.used > 0) && (
                  <Table className="border-t border-line">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th className="text-right">Spent</th>
                        <th className="text-right">Share of the month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sum.allocation.filter((a) => a.used > 0).map((a) => (
                        <tr key={a.category}>
                          <td>{CATEGORY_LABEL[a.category] ?? a.category}</td>
                          <td className="num text-right text-ink-2">{fmtUsdc(a.used, { unit: false })}</td>
                          <td className="num text-right text-ink-3">{m.budgetMicro ? Math.round((a.used / m.budgetMicro) * 100) : 0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                <p className="px-4 pb-4 pt-2 text-[11.5px] text-ink-4">A report, not a limit: any kind of spend can use the whole monthly budget.</p>
              </div>
            </div>
            <CardFooter>
              <span>Overall score = 50% how close you are to the goal + 30% cost per result vs plan + 20% share of tests that worked.</span>
              <Link href="/app/experiments" className="inline-flex shrink-0 items-center gap-1 hover:text-ink">
                Tests <ArrowRight className="size-3" />
              </Link>
            </CardFooter>
          </Card>
        );
      })}

      {missions.length > 0 && (
        <Card>
          <CardHeader title="What we learned" description="Compares the cost per result of your tests, stops the ones that aren't working and moves their unspent budget to the ones that are" icon={<Brain />} action={operate && hasActive ? <ActionButton action={runLearningAction} label="Compare results now" size="xs" logTitle="Compare results" /> : undefined} />
          {learnings.length ? (
            <ul className="divide-y divide-line">
              {learnings.map((l) => (
                <li key={l.id} className="px-4 py-3">
                  <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                    <span className="num" title={l.createdAt.toISOString()}>
                      {relTime(l.createdAt)}
                    </span>
                    <ModeBadge mode={l.dataMode} />
                    {l.decisionId && (
                      <Link href={`/app/receipts/${l.decisionId}`} className="ml-auto inline-flex items-center gap-1 hover:text-ink">
                        Receipt <ArrowRight className="size-3" />
                      </Link>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1.5 text-[12.5px] text-ink-2">
                    {(l.findings as unknown as Finding[]).map((f) => (
                      <li key={f.label} className="flex items-start gap-2">
                        <Badge tone={VERDICT_TONE(f.verdict)} className="mt-px min-w-16 justify-center">
                          {f.verdict.replace(/_/g, " ")}
                        </Badge>
                        <span>
                          <span className="font-medium text-ink">{f.label}</span> — {f.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {(l.reallocations as unknown as Realloc[]).map((r, i) => (
                    <div key={i} className="mt-2 rounded-[6px] bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink">
                      ↳ moved <span className="num">{fmtUsdc(r.amountMicro)}</span>: <span className="text-ink-2">{r.reason}</span>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          ) : (
            <CardBody className="text-[12.5px] text-ink-3">Nothing yet. GrowTendril compares results after each scan once tests have spent something, or when you click “Compare results now”.</CardBody>
          )}
        </Card>
      )}
    </div>
  );
}
