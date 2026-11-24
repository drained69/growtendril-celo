import Link from "next/link";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { ArrowRight, CheckCircle2, FlaskConical, Flag, Radar, Target } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { activeMission, missionSummary } from "@/server/queries/missions";
import { createExperimentAction } from "@/server/actions/growth";
import { EVENT_LABEL, type ConversionEventType } from "@/server/domain/growth/attribution-links";
import { fmtUsdc } from "@/lib/money";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, ModeBadge, PageHeader, StatusBadge } from "@/components/ui";
import { ActionButton } from "@/components/features/agent/action-button";

export default async function StartExperiment() {
  const { project, role, db } = await requireProject();
  const mission = await activeMission(db, project.id);
  const [summary, opportunities, drafts] = await Promise.all([
    mission ? missionSummary(db, mission) : Promise.resolve(null),
    db.select().from(s.opportunities).where(and(eq(s.opportunities.projectId, project.id), eq(s.opportunities.status, "open"), ne(s.opportunities.type, "PRODUCT_ISSUE"))).orderBy(desc(s.opportunities.overallScore)).limit(6),
    db.select().from(s.experiments).where(and(eq(s.experiments.projectId, project.id), inArray(s.experiments.status, ["proposed", "awaiting_approval", "running"]))).orderBy(desc(s.experiments.createdAt)).limit(4),
  ]);
  const operate = can(role, "operate");
  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[{ label: "Experiments", href: "/app/experiments" }]}
        title="Run one growth experiment"
        description="Start with a real signal. Review the work, budget and success measure before you do anything or pay anyone."
        meta={<ModeBadge mode={project.dataMode} />}
      />

      <Card>
        <CardHeader title="1 · Choose the result" icon={<Flag />} action={mission ? <Badge tone="good">Goal set</Badge> : <Badge tone="warn">Needed</Badge>} />
        <CardBody className="space-y-3">
          {mission ? <>
            <p className="text-[14px] font-medium text-ink">{mission.goalDescription}</p>
            <p className="text-[12.5px] text-ink-3">Success event: <span className="text-ink-2">{EVENT_LABEL[mission.goalEvent as ConversionEventType] ?? mission.goalEvent}</span> · Mission limit: <span className="num text-ink-2">{fmtUsdc(mission.budgetMicro)}</span> · Available for new work: <span className="num text-ink-2">{fmtUsdc(summary?.available ?? 0)}</span></p>
            <LinkButton href="/app/missions" variant="ghost" size="sm">Review mission</LinkButton>
          </> : <>
            <p className="text-[12.5px] text-ink-3">Set a goal and maximum mission budget first. A draft experiment will reserve part of that budget; it will not charge your wallet.</p>
            <LinkButton href="/app/missions" variant="primary" icon={<ArrowRight />}>Set a mission</LinkButton>
          </>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="2 · Pick one opportunity" description="Open the original evidence before you commit to a test." icon={<Target />} action={<LinkButton href="/app/opportunities" variant="ghost" size="sm">See all</LinkButton>} />
        {opportunities.length ? <div className="divide-y divide-line">
          {opportunities.map((o) => <div key={o.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{o.title}</span><Badge tone="muted">{o.type === "KOL" ? "Creator" : o.type.toLowerCase().replace(/_/g, " ")}</Badge></div>
              <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-3">{o.whyNow[0] ?? o.recommendedAction}</p>
              <p className="mt-1 text-[11.5px] text-ink-4">Estimated work cost: {fmtUsdc(o.estimatedCostMicro)} · This is an estimate, not a payment request.</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <LinkButton href={`/app/opportunities/${o.id}`} size="sm" variant="outline">Review evidence</LinkButton>
              {operate && mission && <ActionButton action={createExperimentAction.bind(null, o.id)} label="Make a draft" icon={<ArrowRight />} variant="primary" navigateToCreatedExperiment />}
            </div>
          </div>)}
        </div> : <CardBody>
          <EmptyState icon={<Radar />} title="No open opportunities yet" description="A market scan can collect customer, creator and narrative signals. Review its sources before you create a test." action={<LinkButton href="/app/runs" variant="primary">Run a scan</LinkButton>} />
        </CardBody>}
      </Card>

      <Card>
        <CardHeader title="3 · Review, run and measure" description="A draft stays editable until a payment is attempted." icon={<FlaskConical />} />
        <CardBody className="space-y-3">
          {drafts.length ? <div className="divide-y divide-line rounded-[9px] border border-line">
            {drafts.map((draft) => <Link key={draft.id} href={`/app/experiments/${draft.id}`} className="flex items-center justify-between gap-3 px-3 py-3 text-[12.5px] transition-colors hover:bg-surface-2">
              <span className="min-w-0 truncate"><span className="num mr-2 text-ink-4">#{draft.number}</span>{draft.title}</span>
              <span className="flex shrink-0 items-center gap-2"><StatusBadge status={draft.status} /><ArrowRight className="size-3.5 text-ink-3" /></span>
            </Link>)}
          </div> : <p className="text-[12.5px] text-ink-3">Create a draft above. You will then review the proposed work, choose what counts as success, set a stop rule and check how outcomes will be recorded.</p>}
          <p className="flex items-start gap-2 text-[12px] text-ink-3"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />Creator and other payouts still go through your spending policy and human approval. An experiment you run yourself needs no wallet payment.</p>
        </CardBody>
      </Card>
    </div>
  );
}
