import { notFound, redirect } from "next/navigation";
import { requireProject } from "@/server/auth/current";
import { Callout, Card, CardBody, CardHeader, KeyValue, LinkButton, PageHeader } from "@/components/ui";
import { FundOpenCampaign } from "@/components/features/campaigns/open-chain";
import { liveChain, openByProgram } from "@/server/domain/growth/open-campaigns";
import { PROOF_LABEL, type ProofKind } from "@/lib/open-campaigns";
import { fmtUsdc } from "@/lib/money";

export default async function FundOpenCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, { db, project } = await requireProject("approve");
  const row = await openByProgram(db, project.id, id).catch(() => null);
  if (!row) notFound();
  const { campaign: c, program: p } = row;
  if (!["draft", "funding"].includes(c.status)) redirect(`/app/campaigns/${id}`);
  const total = p.baseMicro * p.slots, contract = (await liveChain()).contract();
  return <div className="mx-auto max-w-2xl space-y-5">
    <PageHeader title="Set the money aside" description={c.title} actions={<LinkButton href={`/app/campaigns/${id}`}>Back to the campaign</LinkButton>} />
    <Card><CardHeader title="What you're setting aside" /><CardBody className="space-y-4">
      <KeyValue items={[
        { k: "Reward", v: `${fmtUsdc(p.baseMicro)} per person` },
        { k: "People", v: p.slots },
        { k: "Total", v: <strong>{fmtUsdc(total)}</strong> },
        { k: "Runs for", v: `${c.durationDays} days from now` },
        { k: "Proof", v: `${PROOF_LABEL[c.proofKind as ProofKind]}${c.requiredText ? `, including "${c.requiredText}"` : ""}` },
      ]} />
      <p className="text-sm text-ink-2">The money moves from your wallet into GrowTendril&apos;s campaign contract on the Celo network. Only approved people can receive it, after a 3-day hold in which you can object. Anything unused comes back to you 7 days after the campaign ends.</p>
    </CardBody></Card>
    <Card><CardHeader title="What you need" /><CardBody className="space-y-2 text-sm text-ink-2">
      <p>• A wallet on Celo, such as MiniPay, Valora or MetaMask, holding at least <strong>{fmtUsdc(total)}</strong>. USDC is a digital dollar: 1 USDC = $1.</p>
      <p>• A few cents of CELO in the same wallet to pay the network fees.</p>
      <p>• Use a normal wallet you control. Your wallet will ask you to confirm twice: once to allow the exact amount, once to set it aside.</p>
    </CardBody></Card>
    {contract ? <Card><CardBody><FundOpenCampaign programId={id} totalMicro={total} /></CardBody></Card>
      : <Callout tone="warn" title="Not available yet">Campaign payments aren&apos;t switched on for this server yet. Your campaign is saved; come back later.</Callout>}
    <p className="text-xs text-ink-3">Before anything is sent, this page checks that the contract on Celo is GrowTendril&apos;s campaign contract, using Celo USDC. The contract has automated tests but no independent audit yet, so campaigns are capped at $500 for now.</p>
  </div>;
}
