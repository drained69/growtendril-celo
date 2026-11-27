import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { currentUser } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import { Callout, Card, CardBody, CardHeader, LinkButton } from "@/components/ui";
import { openBySlug, takenSpots } from "@/server/domain/growth/open-campaigns";
import { PROOF_LABEL, type ProofKind } from "@/lib/open-campaigns";
import { fmtUsdc } from "@/lib/money";

export const dynamic = "force-dynamic";
const day = (d: Date) => d.toUTCString().slice(0, 16);

async function load(slug: string) {
  const db = await getDb(), row = await openBySlug(db, slug);
  if (!row || !["live", "ended", "closed"].includes(row.campaign.status) || !row.campaign.escrowCampaignId) return null;
  return { ...row, taken: await takenSpots(db, row.campaign.id) };
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const row = await load((await params).slug);
  return row ? { title: `${row.campaign.title} · ${row.business}`, description: `Earn ${fmtUsdc(row.program.baseMicro)} from ${row.business}: ${row.campaign.task.slice(0, 140)}` } : { title: "Campaign not found" };
}

/** The public campaign page: what to do, what you get, when you're paid, and proof the money is already set aside. */
export default async function JoinPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params, [row, user] = await Promise.all([load(slug), currentUser()]);
  if (!row) notFound();
  const { campaign: c, program: p, business, taken } = row;
  const open = c.status === "live" && !!c.endsAt && c.endsAt > new Date() && taken < p.slots;
  const next = encodeURIComponent(`/creator/join/${slug}`);
  return <main className="mx-auto max-w-2xl space-y-5 p-5 py-12">
    <div className="space-y-2">
      <p className="text-sm text-ink-3">{business} is paying people to help</p>
      <h1 className="text-3xl font-semibold tracking-tight">{c.title}</h1>
      <p className="text-lg">Earn <strong>{fmtUsdc(p.baseMicro)}</strong> in USDC <span className="text-ink-3">(a digital dollar: 1 USDC = $1)</span></p>
      <p className="text-sm text-ink-3">{Math.max(0, p.slots - taken)} of {p.slots} spots left · {c.endsAt ? `ends ${day(c.endsAt)}` : ""}</p>
    </div>

    <Card><CardHeader title="What to do" /><CardBody className="space-y-3 text-sm">
      <p className="whitespace-pre-wrap">{c.task}</p>
      <p className="text-ink-2">Then send us the link: {PROOF_LABEL[c.proofKind as ProofKind].toLowerCase()} that shows the personal code you get when you join{c.requiredText ? <>, and the words <strong>{c.requiredText}</strong></> : ""}.</p>
    </CardBody></Card>

    <Card><CardHeader title="How you get paid" /><CardBody className="space-y-2 text-sm text-ink-2">
      <p>1. Join and agree to the terms by signing with your wallet. Signing is free and moves no money.</p>
      <p>2. Do the task and send us the link. GrowTendril checks it, usually within a minute.</p>
      <p>3. Once approved, the reward waits 3 days. During that time {business} can still object. After that it&apos;s sent to your wallet automatically.</p>
      <p>One reward per person and per wallet.</p>
    </CardBody></Card>

    <Card><CardHeader title="The money is already set aside" /><CardBody className="space-y-2 text-sm text-ink-2">
      <p>{business} put {fmtUsdc(p.baseMicro * p.slots)} into a contract on the Celo network before this page went live. It can only go to approved people, or back to {business} after the campaign.</p>
      <p className="flex flex-wrap gap-3 text-xs">
        {c.fundingTx && <a className="underline" href={`https://celoscan.io/tx/${c.fundingTx}`} target="_blank" rel="noopener noreferrer">See the deposit on Celoscan</a>}
        {c.escrowContract && <a className="underline" href={`https://celoscan.io/address/${c.escrowContract}`} target="_blank" rel="noopener noreferrer">See the contract</a>}
      </p>
    </CardBody></Card>

    <Card><CardHeader title="You need a wallet on Celo" /><CardBody className="space-y-2 text-sm text-ink-2">
      <p>Your reward goes to a wallet you control. The easiest is <a className="underline" href="https://www.opera.com/products/minipay" target="_blank" rel="noopener noreferrer">MiniPay</a> (inside Opera Mini, on Android and iPhone). <a className="underline" href="https://valora.xyz" target="_blank" rel="noopener noreferrer">Valora</a> or MetaMask work too. You don&apos;t need any money in it to join.</p>
    </CardBody></Card>

    {open ? <div className="flex flex-wrap gap-3">
      {user ? <LinkButton href={`/creator/join/${slug}`} variant="primary">Join this campaign</LinkButton>
        : <><LinkButton href={`/signup?next=${next}`} variant="primary">Join this campaign</LinkButton><LinkButton href={`/login?next=${next}`}>I already have an account</LinkButton></>}
    </div> : <Callout tone="info" title={c.status === "live" && taken >= p.slots ? "All spots are taken" : "This campaign has ended"}>{user ? <a className="underline" href="/creator">See your campaigns</a> : "Thanks for your interest."}</Callout>}
    <p className="text-xs text-ink-3">You join as a participant. You don&apos;t need a business account.</p>
  </main>;
}
