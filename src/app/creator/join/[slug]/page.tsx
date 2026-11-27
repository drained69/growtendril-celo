import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { currentUser } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import { Badge, Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { CopyButton } from "@/components/ui/copy";
import { CollectButton } from "@/components/features/campaigns/open-chain";
import { JoinOpenCampaign, ProofForm } from "@/components/features/campaigns/open-forms";
import { fundingParams, myOpenJoin, openBySlug } from "@/server/domain/growth/open-campaigns";
import { CLAIM_STATUS_FOR_PARTICIPANT, CLAIM_TONE, MAX_CLAIM_TRIES, PROOF_LABEL, type ProofKind } from "@/lib/open-campaigns";
import { fmtUsdc } from "@/lib/money";
import { appOrigin } from "@/server/lib/origin";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };
const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const PLACEHOLDER: Record<ProofKind, string> = { x: "https://x.com/you/status/…", bluesky: "https://bsky.app/profile/you/post/…", youtube: "https://www.youtube.com/watch?v=…", tiktok: "https://www.tiktok.com/@you/video/…", link: "https://…" };

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children?: ReactNode }) {
  return <Card><CardHeader title={`${n}. ${title}`} action={done ? <Badge tone="good">Done</Badge> : active ? <Badge tone="info">Now</Badge> : undefined} />{active || done ? <CardBody className="space-y-3 text-sm">{children}</CardBody> : null}</Card>;
}

/** A participant's path through one campaign: agree and sign, do the task, send proof, get paid. */
export default async function JoinSteps({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params, db = await getDb(), [user, row] = await Promise.all([currentUser(), openBySlug(db, slug)]);
  if (!row || !row.campaign.escrowCampaignId) notFound();
  const { campaign: c, program: p, business } = row, next = encodeURIComponent(`/creator/join/${slug}`);
  if (!user || !user.emailVerified) return <main className="mx-auto max-w-xl space-y-5 p-5 py-12">
    <PageHeader title={c.title} description={`Earn ${fmtUsdc(p.baseMicro)} from ${business}`} />
    <Card><CardBody className="flex flex-wrap gap-3">{!user ? <><LinkButton href={`/signup?next=${next}`} variant="primary">Create an account</LinkButton><LinkButton href={`/login?next=${next}`}>Sign in</LinkButton></> : <LinkButton href={`/verify?next=${next}`} variant="primary">Confirm your email to continue</LinkButton>}</CardBody></Card>
  </main>;
  const mine = await myOpenJoin(db, user.id, c.id), origin = await appOrigin();
  const open = c.status === "live" && !!c.endsAt && c.endsAt > new Date();
  const claim = mine?.claim ?? null, link = mine ? `${origin}/r/${mine.link}` : "";
  const canResend = !!claim && claim.status === "rejected" && claim.decidedBy === "auto" && claim.attempts < MAX_CLAIM_TRIES && open;
  const params2 = fundingParams(c, p);
  const collectable = claim?.status === "approved_queued" && !!claim.claimableAt && claim.claimableAt <= new Date();

  return <main className="mx-auto max-w-2xl space-y-4 p-5 py-10">
    <PageHeader title={c.title} description={`${business} · ${fmtUsdc(p.baseMicro)} per person · ends ${c.endsAt ? day(c.endsAt) : "—"}`} actions={<><LinkButton href={`/join/${slug}`}>Campaign page</LinkButton><LinkButton href="/creator">My campaigns</LinkButton></>} />

    <Step n={1} title="Agree and sign" done={!!mine} active={!mine}>
      {mine ? <p>You agreed with the wallet {mine.participant.payoutAddress.slice(0, 6)}…{mine.participant.payoutAddress.slice(-4)}. Your reward goes there.</p> : open ? <>
        <p>Read the terms. Then connect the wallet you want to be paid in and sign. Signing is free and moves no money; it proves the wallet is yours.</p>
        <details><summary className="cursor-pointer text-ink-2">Read the full terms</summary><pre className="mt-2 whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{c.termsText}</pre></details>
        <JoinOpenCampaign slug={slug} />
        <p className="text-xs text-ink-3">No wallet yet? <a className="underline" href="https://www.opera.com/products/minipay" target="_blank" rel="noopener noreferrer">MiniPay</a> takes a minute to set up. Open this page inside it to sign.</p>
      </> : <p className="text-ink-3">This campaign isn&apos;t taking new people.</p>}
    </Step>

    <Step n={2} title="Do the task" done={!!claim && claim.status !== "rejected"} active={!!mine && (!claim || canResend)}>
      <p className="whitespace-pre-wrap">{c.task}</p>
      {mine && <div className="space-y-2 rounded-xl border border-line p-3">
        <p>Put your personal code in the post{c.requiredText ? <>, with the words <strong>{c.requiredText}</strong></> : ""}:</p>
        <div className="flex items-center gap-2"><code className="text-base font-semibold">{mine.participant.code}</code><CopyButton value={mine.participant.code} /></div>
        <p className="text-xs text-ink-3">Or add your personal link, which takes people to {business}:</p>
        <div className="flex items-center gap-2"><code className="break-all text-xs">{link}</code><CopyButton value={link} /></div>
      </div>}
    </Step>

    <Step n={3} title="Send your proof" done={!!claim && claim.status !== "rejected"} active={!!mine && (!claim || claim.status === "rejected")}>
      {claim && claim.status === "rejected" && <p className="text-critical">{claim.rejectReason}</p>}
      {mine && (!claim || canResend) && open && <ProofForm participantId={mine.participant.id} placeholder={PLACEHOLDER[c.proofKind as ProofKind]} label={claim ? "Send it again" : "Send my proof"} />}
      {mine && !claim && !open && <p className="text-ink-3">The campaign has ended, so proof can&apos;t be sent any more.</p>}
      {!claim && <p className="text-xs text-ink-3">Send the link to {PROOF_LABEL[c.proofKind as ProofKind].toLowerCase()}. It must be public.</p>}
      {claim && claim.status !== "rejected" && <a className="break-all underline" href={claim.proofUrl} target="_blank" rel="noopener noreferrer">{claim.proofUrl}</a>}
    </Step>

    <Step n={4} title="Get paid" done={claim?.status === "paid"} active={!!claim && claim.status !== "rejected"}>
      {claim && <>
        <p><Badge tone={CLAIM_TONE[claim.status] ?? "neutral"}>{CLAIM_STATUS_FOR_PARTICIPANT[claim.status] ?? claim.status}</Badge></p>
        {claim.status === "approved_queued" && claim.claimableAt && !collectable && <p>{fmtUsdc(claim.amountMicro ?? p.baseMicro)} is set aside for you. It&apos;s sent to your wallet automatically after {day(claim.claimableAt)}. Until then, {business} can still object.</p>}
        {collectable && params2 && <><p>The hold is over. We&apos;re sending it now; you can also collect it yourself (a few cents of CELO for the network fee).</p><CollectButton claimId={claim.id} contract={params2.contract} campaignId={c.escrowCampaignId!} rewardId={claim.rewardId} attribution={params2.attribution} /></>}
        {claim.status === "paid" && <p>{fmtUsdc(claim.amountMicro ?? p.baseMicro)} was sent to your wallet. {claim.payTx && <a className="underline" href={`https://celoscan.io/tx/${claim.payTx}`} target="_blank" rel="noopener noreferrer">See it on Celoscan</a>}</p>}
        {claim.status === "objected" && claim.objectionReason && <p className="text-ink-3">Their reason: {claim.objectionReason}</p>}
        {claim.status === "needs_owner" && <p className="text-ink-3">We couldn&apos;t confirm everything automatically, so {business} will look at it.</p>}
      </>}
    </Step>
  </main>;
}
