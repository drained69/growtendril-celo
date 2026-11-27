import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { Gift, Megaphone } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import * as s from "@/server/db/schema";
import { Badge, Card, CardHeader, CardBody, PageHeader, StatusBadge, LinkButton } from "@/components/ui";
import { CampaignForm } from "@/components/features/campaigns/forms";
import { fmtUsdc, microToDecimal } from "@/lib/money";
import { loadPolicy } from "@/server/domain/agent/ledger";
import { CAMPAIGN_STATUS_LABEL, PROOF_LABEL, type ProofKind } from "@/lib/open-campaigns";
export default async function Campaigns() {
  const { db, project, role } = await requireProject();
  const policy = await loadPolicy(db, project.id);
  const rows = await db.select({ program: s.creatorPrograms, experiment: s.experiments }).from(s.creatorPrograms)
    .innerJoin(s.experiments, eq(s.experiments.id, s.creatorPrograms.experimentId)).where(and(eq(s.creatorPrograms.projectId, project.id), eq(s.creatorPrograms.mode, "invite"))).orderBy(desc(s.creatorPrograms.createdAt));
  const open = await db.select({ campaign: s.openCampaigns, program: s.creatorPrograms }).from(s.openCampaigns)
    .innerJoin(s.creatorPrograms, eq(s.creatorPrograms.id, s.openCampaigns.programId)).where(eq(s.openCampaigns.projectId, project.id)).orderBy(desc(s.openCampaigns.createdAt));
  return <div className="space-y-6">
    <PageHeader title="Campaigns" description="Pay people a fixed reward for posting about your business. Anyone with the link can join; GrowTendril checks each claim and you can object before anyone is paid."
      actions={can(role, "manage_policy") ? <LinkButton href="/app/campaigns/new" variant="primary" icon={<Gift />}>New reward campaign</LinkButton> : undefined} />
    {open.length ? <div className="grid gap-4 md:grid-cols-2">{open.map(({ campaign: c, program: p }) => <Link href={`/app/campaigns/${p.id}`} key={c.id}><Card interactive><CardBody>
      <div className="flex justify-between gap-3"><h2 className="font-semibold">{c.title}</h2><Badge tone={c.status === "live" ? "good" : c.status === "closed" ? "muted" : "warn"}>{CAMPAIGN_STATUS_LABEL[c.status] ?? c.status}</Badge></div>
      <p className="mt-2 text-sm text-ink-3">{PROOF_LABEL[c.proofKind as ProofKind]} · {p.slots} {p.slots === 1 ? "person" : "people"}</p>
      <p className="mt-4 text-xl font-semibold">{fmtUsdc(p.baseMicro)} <span className="text-xs font-normal text-ink-3">per person · {fmtUsdc(p.baseMicro * p.slots)} in total</span></p>
    </CardBody></Card></Link>)}</div>
      : <Card><CardBody><p className="text-sm text-ink-3">No reward campaigns yet. {can(role, "manage_policy") ? <Link className="underline" href="/app/campaigns/new">Create one</Link> : "An owner or admin can create one."}</p></CardBody></Card>}

    <details className="space-y-4" open={rows.length > 0}>
      <summary className="cursor-pointer text-sm font-medium text-ink-2">Invite-only creator campaigns</summary>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">{rows.map(({program:p,experiment:e}) => <Link href={`/app/campaigns/${p.id}`} key={p.id}><Card interactive><CardBody><div className="flex justify-between gap-3"><h2 className="font-semibold">{e.title}</h2><StatusBadge status={e.status} /></div><p className="mt-2 text-sm text-ink-3">{p.topic} · {p.platform} · {p.slots} creator slots</p><p className="mt-4 text-xl font-semibold">{fmtUsdc(e.budgetMicro)} <span className="text-xs font-normal text-ink-3">reward pool</span></p><p className="mt-2 text-xs text-ink-3">Target: {e.successTarget} {e.successEvent.replace(/_/g," ")} · maximum {fmtUsdc(e.stopMaxCpaMicro)} per action</p></CardBody></Card></Link>)}</div>
        {can(role,"manage_policy") ? <Card id="new"><CardHeader title={rows.length ? "Start another invite-only campaign" : "Invite specific creators instead"} icon={<Megaphone />} description="You invite each creator with a private link. Campaigns run for 14 days." /><CardBody><CampaignForm paymentCeilingUsdc={microToDecimal(policy.hardCeilingMicro)} /></CardBody></Card> : <p className="text-sm text-ink-3">A workspace owner or admin can create a campaign.</p>}
      </div>
    </details>
  </div>;
}
