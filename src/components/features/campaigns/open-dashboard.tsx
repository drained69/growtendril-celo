import { getAddress, type Hex } from "viem";
import { and, eq, like } from "drizzle-orm";
import * as s from "@/server/db/schema";
import type { DB } from "@/server/db/client";
import { can, type Role } from "@/server/auth/access";
import { Badge, Callout, Card, CardBody, CardHeader, LinkButton, PageHeader, Stat, StatStrip } from "@/components/ui";
import { CopyField } from "@/components/ui/copy";
import { ActionButton } from "@/components/features/agent/action-button";
import { Countdown, OwnerChainButton } from "@/components/features/campaigns/open-chain";
import { RejectClaimForm } from "@/components/features/campaigns/open-forms";
import { approveOpenClaimAction, endOpenCampaignAction, setOpenAutoApproveAction } from "@/server/actions/open-campaigns";
import { fundingParams, liveChain, openByProgram, openClaimsFor, openParticipantCount, reviewEndsAt } from "@/server/domain/growth/open-campaigns";
import { CAMPAIGN_STATUS_LABEL, CLAIM_STATUS_LABEL, CLAIM_TONE, COLLECT_WINDOW_MS, PROOF_LABEL, SPOT_TAKING, openEvidenceHash, type OnchainCampaign, type ProofKind } from "@/lib/open-campaigns";
import { fmtUsdc } from "@/lib/money";

const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The owner's view of an open campaign: share link, claims to decide, the 3-day objection window, and the money. */
export async function OpenCampaignDashboard({ db, projectId, programId, role, origin }: { db: DB; projectId: string; programId: string; role: Role; origin: string }) {
  const { campaign: c, program: p } = await openByProgram(db, projectId, programId);
  const [claims, joined, alerts] = await Promise.all([openClaimsFor(db, c.id), openParticipantCount(db, c.id),
    c.escrowCampaignId ? db.select({ detail: s.ledgerExceptions.detail }).from(s.ledgerExceptions).where(and(eq(s.ledgerExceptions.projectId, projectId), eq(s.ledgerExceptions.kind, "unexpected_reward"), eq(s.ledgerExceptions.status, "open"), like(s.ledgerExceptions.ref, `${c.escrowCampaignId}:%`))) : Promise.resolve([])]);
  const chain = await liveChain();
  let onchain: OnchainCampaign | null = null;
  if (c.escrowCampaignId && c.escrowContract) { try { onchain = await chain.readCampaign(getAddress(c.escrowContract), c.escrowCampaignId as Hex); } catch { onchain = null; } }
  const params = fundingParams(c, p);
  const funded = !!c.escrowCampaignId && !!c.ownerAddress && !!params;
  const operator = chain.agent();
  const agentOn = !!c.agentAddress && !!operator && c.agentAddress.toLowerCase() === operator.toLowerCase();
  const taken = claims.filter(x => SPOT_TAKING.includes(x.claim.status as never)).length;
  const paid = claims.filter(x => x.claim.status === "paid").reduce((n, x) => n + (x.claim.amountMicro ?? p.baseMicro), 0);
  const waiting = claims.filter(x => x.claim.status === "needs_owner").length;
  const canDecide = can(role, "approve"), canManage = can(role, "manage_policy");
  const joinUrl = `${origin}/join/${c.slug}`;
  const refundFrom = c.endsAt ? reviewEndsAt(c.endsAt) : null, refundOpen = !!refundFrom && refundFrom <= new Date();
  const chainProps = funded ? { programId, contract: params!.contract, campaignId: c.escrowCampaignId!, ownerAddress: c.ownerAddress!, attribution: params!.attribution } : null;

  return <div className="space-y-5">
    <PageHeader title={c.title} description={`${CAMPAIGN_STATUS_LABEL[c.status] ?? c.status} · open to anyone with the link · ${fmtUsdc(p.baseMicro)} per person`}
      actions={<><LinkButton href="/app/campaigns">All campaigns</LinkButton>{funded && <LinkButton href={`/join/${c.slug}`} external>Open the public page</LinkButton>}</>} />
    {alerts.length > 0 && <Callout tone="danger" title="A reward GrowTendril didn't approve is on Celo">{alerts[alerts.length - 1].detail} You can mark it resolved on the Payout account page once you know what happened.</Callout>}
    {!funded && c.status !== "closed" && <Callout tone="warn" title="Set the money aside to open this campaign" action={canDecide ? <LinkButton href={`/app/campaigns/${programId}/fund`} variant="primary">Set the money aside</LinkButton> : undefined}>
      People can join only after {fmtUsdc(p.baseMicro * p.slots)} is held in the campaign contract on Celo. It comes from your own wallet; GrowTendril never holds it.
    </Callout>}
    <StatStrip className="grid-cols-2 lg:grid-cols-4">
      <Stat label="Spots taken" value={`${taken} / ${p.slots}`} sub={`${joined} joined`} />
      <Stat label="Waiting for you" value={waiting} tone={waiting ? "warn" : undefined} />
      <Stat label="Paid out" value={fmtUsdc(paid)} />
      <Stat label="Still in the campaign" value={onchain ? fmtUsdc(Number(onchain.available + onchain.reserved)) : "—"} sub={onchain ? `${fmtUsdc(Number(onchain.reserved))} held for approved people` : funded ? "Couldn't read Celo just now" : "Not set aside yet"} />
    </StatStrip>

    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Claims</h2>
        {!claims.length && <Card><CardBody><p className="text-sm text-ink-3">{funded ? "No claims yet. Share the link below; people who join get a personal code to put in their post." : "Claims appear here once the campaign is open."}</p></CardBody></Card>}
        {claims.map(({ claim: x, participant: who, user }) => {
          const holdOver = !!x.claimableAt && x.claimableAt <= new Date();
          return <Card key={x.id}><CardBody className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><p className="font-medium">{user.name}</p><p className="text-xs text-ink-3">Code {who.code} · pays to {who.payoutAddress.slice(0, 6)}…{who.payoutAddress.slice(-4)}</p></div>
              <Badge tone={CLAIM_TONE[x.status] ?? "neutral"}>{CLAIM_STATUS_LABEL[x.status] ?? x.status}</Badge>
            </div>
            <a href={x.proofUrl} target="_blank" rel="noopener noreferrer" className="block break-all text-sm underline">{x.proofUrl}</a>
            {x.rejectReason && <p className="text-xs text-ink-3">Reason given: {x.rejectReason}</p>}
            {x.objectionReason && <p className="text-xs text-ink-3">Your objection: {x.objectionReason}</p>}
            {x.queueError && ["approved_waiting", "queueing", "needs_owner"].includes(x.status) && <p className="text-xs text-warning">{x.queueError}</p>}
            {x.status === "approved_queued" && x.claimableAt && <p className="text-sm">{holdOver ? <>The hold is over. They can collect it now; otherwise GrowTendril sends it by {day(new Date(x.claimableAt.getTime() + COLLECT_WINDOW_MS))}.</> : <>You can object until {day(x.claimableAt)} (<Countdown until={x.claimableAt.toISOString()} />). After that it&apos;s paid.</>}</p>}
            {x.status === "paid" && x.payTx && <a className="text-xs underline" href={`https://celoscan.io/tx/${x.payTx}`} target="_blank" rel="noopener noreferrer">Payment on Celoscan</a>}
            {!!x.checks.length && <details className="text-xs text-ink-3"><summary className="cursor-pointer">What GrowTendril checked</summary><ul className="mt-2 space-y-1">{x.checks.map(k => <li key={k.key}>{k.result === "pass" ? "✓" : k.result === "fail" ? "✗" : "?"} {k.detail}</li>)}</ul></details>}
            {canDecide && <div className="flex flex-wrap items-start gap-2">
              {x.status === "needs_owner" && <><ActionButton action={approveOpenClaimAction.bind(null, programId, x.id)} label={`Approve · ${fmtUsdc(p.baseMicro)}`} variant="primary" size="xs" /><RejectClaimForm programId={programId} claimId={x.id} label="Turn down" /></>}
              {x.status === "approved_waiting" && <RejectClaimForm programId={programId} claimId={x.id} label="Object" />}
              {x.status === "approved_waiting" && !agentOn && chainProps && <OwnerChainButton {...chainProps} kind="queue" claimId={x.id} rewardId={x.rewardId} recipient={who.payoutAddress}
                evidenceHash={openEvidenceHash({ claimId: x.id, proofUrl: x.proofUrl, proofTextHash: x.proofTextHash, decidedBy: x.decidedBy })} label="Approve in your wallet" variant="primary" />}
              {x.status === "approved_queued" && !holdOver && chainProps && <OwnerChainButton {...chainProps} kind="object" claimId={x.id} rewardId={x.rewardId} label="Object" />}
            </div>}
          </CardBody></Card>;
        })}
      </div>

      <div className="space-y-4">
        {funded && <Card><CardHeader title="Share this link" description="Anyone with it can join, agree to the terms and claim." /><CardBody className="space-y-2"><CopyField value={joinUrl} mono={false} /><p className="text-xs text-ink-3">Ends {c.endsAt ? day(c.endsAt) : "—"}.</p></CardBody></Card>}
        {funded && <Card><CardHeader title="Approving claims" /><CardBody className="space-y-3 text-sm">
          <p>{c.autoApprove && agentOn ? "On: GrowTendril approves claims that pass every check. You can still object for 3 days before anyone is paid." : "Off: every claim waits for you."}</p>
          {canDecide && agentOn && <ActionButton action={setOpenAutoApproveAction.bind(null, programId, !c.autoApprove)} label={c.autoApprove ? "Turn automatic approval off" : "Turn automatic approval on"} />}
          <div className="border-t border-line pt-3 space-y-2">
            <p className="text-xs text-ink-3">{agentOn ? "GrowTendril can approve rewards in this campaign, within the terms. You can remove that permission on Celo at any time; you'd then approve each reward from your wallet." : "GrowTendril can't approve rewards here. Approved claims wait for you to approve them in your wallet."}</p>
            {canDecide && chainProps && agentOn && <OwnerChainButton {...chainProps} kind="removeAgent" label="Remove GrowTendril's permission" variant="danger" confirmText="Remove GrowTendril's permission to approve rewards in this campaign? Rewards already approved still finish." />}
            {canDecide && chainProps && !agentOn && operator && <OwnerChainButton {...chainProps} kind="restoreAgent" agent={operator} label="Let GrowTendril approve again" />}
          </div>
        </CardBody></Card>}
        {funded && <Card><CardHeader title="Unused money" /><CardBody className="space-y-2 text-sm">
          <p>{onchain ? `${fmtUsdc(Number(onchain.available))} isn't used by any reward.` : "Money nobody earned comes back to you."} {refundOpen ? "You can take it back now." : `You can take it back from ${refundFrom ? day(refundFrom) : "—"} (7 days after the end, so last claims can finish).`}</p>
          {canManage && chainProps && <OwnerChainButton {...chainProps} kind="refund" label="Take back unused money" disabled={!refundOpen || onchain?.available === 0n} />}
        </CardBody></Card>}
        <Card><CardHeader title="Terms people agree to" /><CardBody className="space-y-2">
          {c.termsText ? <pre className="whitespace-pre-wrap text-xs text-ink-2">{c.termsText}</pre> : <p className="text-sm text-ink-3">{c.task}<br /><br />Proof: {PROOF_LABEL[c.proofKind as ProofKind]}{c.requiredText ? `, including "${c.requiredText}"` : ""}. The exact terms are fixed when you set the money aside.</p>}
          {c.termsHash && <p className="break-all text-[11px] text-ink-3">Fingerprint stored on Celo: {c.termsHash}</p>}
        </CardBody></Card>
        {canManage && ["draft", "funding", "live"].includes(c.status) && <ActionButton action={endOpenCampaignAction.bind(null, programId)} label={funded ? "Stop taking new people" : "Delete this draft"} variant="ghost"
          confirm={funded ? "Stop taking new people and new proof? Rewards already approved still finish." : "Delete this campaign? Only do this if you haven't set money aside for it."} />}
      </div>
    </div>
  </div>;
}
