import Link from "next/link";
import { eq } from "drizzle-orm";
import { Globe2, KeyRound, Landmark, RefreshCw, ShieldCheck, Unlock, Wallet as WalletIcon } from "lucide-react";
import { WorkspaceContract } from "@/components/features/wallet/workspace-contract";
import { loadProtocolView } from "@/server/integrations/celo/protocol";
import { loadPolicy } from "@/server/domain/agent/ledger";
import { AltanaWallet } from "@/components/features/wallet/altana-wallet";
import { openSession } from "@/server/integrations/celo/altana";
import { PAYOUT_TOKEN_KEYS } from "@/server/integrations/celo/corridors";
import { requireProject } from "@/server/auth/current";
import { can } from "@/server/auth/access";
import { schema as s } from "@/server/db/client";
import { getWallet, walletBalances, walletIsLive } from "@/server/integrations/celo/wallets";
import { CELO, addressExplorerUrl, custodyProblem } from "@/server/integrations/celo/config";
import { provisionWalletAction, refreshSettlementsAction, toggleFreezeAction } from "@/server/actions/wallet";
import { fmtUsdc } from "@/lib/money";
import { Callout, Card, CardBody, CardHeader, ExternalLink, KeyValue, PageHeader, Stat, StatStrip } from "@/components/ui";
import { CopyField } from "@/components/ui/copy";
import { ActionButton } from "@/components/features/agent/action-button";
import { LedgerExceptions } from "@/components/features/wallet/ledger-exceptions";
import { UsdcHelp } from "@/components/features/billing/usdc-help";
import { monthUsage } from "@/server/domain/growth/monthly-budget";
import { resetLabel } from "@/lib/budget";
import { WithdrawForm } from "@/components/features/wallet/withdraw-form";
import { withdrawable } from "@/server/domain/agent/withdraw";
import { exceptionsFor } from "@/server/domain/reconcile/exceptions";
import { spentTodayMicro } from "@/server/queries/activity";
import { activeMission } from "@/server/queries/missions";
import { effectivePaymentCeiling } from "@/server/domain/agent/policy";

export default async function WalletPage() {
  const { project, role, db } = await requireProject();
  const manage = can(role, "manage_wallet");
  const [wallet, spent, [policy], mission, exceptions] = await Promise.all([
    getWallet(db, project.id), spentTodayMicro(db, project.id),
    db.select().from(s.policies).where(eq(s.policies.projectId, project.id)),
    activeMission(db, project.id), exceptionsFor(db, {projectId: project.id, scope: "wallet", limit: 30}),
  ]);
  const balances = await walletBalances(wallet);
  const live = walletIsLive(wallet);
  const owner = can(role, "manage_workspace");
  // A workspace contract withdraws from its own panel, signed by the owner's wallet.
  const withdrawal = owner && live && wallet?.provider !== "altana" && wallet?.provider !== "growth_vault" ? await withdrawable(db, project.id).catch(() => null) : null;
  const session = await openSession(db, project.id);
  const protocol = await loadProtocolView(db, project, wallet, policy ? await loadPolicy(db, project.id) : null, mission ?? null).catch(() => null);
  const operatorWorkspace = process.env.CELO_AGENT_PROJECT_ID === project.id;
  // Server-wallet setup concerns only the operator's own workspace; customers never see it.
  const issue = operatorWorkspace ? custodyProblem() : null;
  const contract = wallet?.provider === "growth_vault";
  const contractFunds = contract ? protocol?.funds ?? [] : [];
  const usdcHeld = contract ? contractFunds.find((f) => f.token === "USDC")?.balance : balances.walletMicro;
  const usdtHeld = contractFunds.find((f) => f.token === "USD₮")?.balance;
  // An Altana wallet has its own card below; only a server-held wallet gets this one.
  const showServerWallet = (!!wallet?.address && !contract && wallet.provider !== "altana") || (!wallet && !protocol && operatorWorkspace);
  const month = mission ? await monthUsage(db, mission) : null;
  const otherOption = !wallet && !!protocol;
  const altanaCard = <AltanaWallet address={wallet?.address ?? null} canManage={manage} workspaceName={project.name} session={session ? {id: session.id, publicKey: session.publicKey, capUsd: fmtUsdc(session.capMicro), period: session.period, expiresAt: session.expiresAt.toISOString(), grantTxHash: session.grantTxHash, revokeTxHash: session.revokeTxHash} : null} />;
  return <div className="space-y-4">
    <PageHeader title="Payout account" description="The money that pays people, such as creators. It stays in an account only you control, and we ask you before paying any person."
      actions={<ActionButton action={refreshSettlementsAction} label="Check for payment updates" icon={<RefreshCw />} />} />
    <StatStrip className="grid-cols-2 lg:grid-cols-4">
      <Stat label="In your account" value={usdcHeld == null ? "—" : fmtUsdc(Number(usdcHeld))} sub={contract ? `${usdtHeld ? fmtUsdc(Number(usdtHeld)).replace("USDC", "USD₮") : "0 USD₮"} for local-currency payouts` : wallet ? "Ready for approved payments" : "Not set up yet"} />
      <Stat label="This month" value={month ? `${fmtUsdc(month.usedMicro, { unit: false })} of ${fmtUsdc(month.budgetMicro, { unit: false })}` : "—"} sub={month ? `USDC used · resets on ${resetLabel(month.resetsAt)}` : <Link className="underline" href="/onboarding?step=3">Set a goal and budget</Link>} />
      <Stat label="Largest single payment" value={policy ? fmtUsdc(effectivePaymentCeiling(policy)) : "—"} sub={<Link className="underline" href="/app/settings#budget">Change in Settings</Link>} />
      <Stat label="Paid today" value={fmtUsdc(spent)} sub="We ask you before every payment to a person" />
    </StatStrip>
    {issue && <Callout tone="warn" title="Agent wallet setup incomplete">{issue}</Callout>}
    {!!balances.errors.length && <Callout tone="warn" title="We couldn't read your balance just now">Refresh the page to try again. <details className="mt-1 text-[12px] text-ink-3"><summary className="cursor-pointer">Details</summary>{balances.errors.join(" · ")}</details></Callout>}
    {wallet?.frozen && <Callout tone="danger" title="Payments are paused" action={manage && !contract ? <ActionButton action={toggleFreezeAction} label="Turn payments back on" icon={<Unlock />} /> : undefined}>{contract ? "Nothing can be paid until you turn payments back on in your Payout account below." : "Nothing can be paid until an owner or admin turns payments back on."}</Callout>}
    <LedgerExceptions items={exceptions} canResolve={manage} />
    {protocol && (!wallet || contract) && <Card><CardHeader title={contract ? "Your Payout account" : "Set up your Payout account"} description={contract ? "Your money, your limits, your approvals" : "Recommended: create it, add money, and you're done"} icon={<Landmark />} />
      <CardBody><WorkspaceContract view={protocol} canManage={manage} /></CardBody>
    </Card>}
    {showServerWallet && <Card><CardHeader title="Payout account" description={live ? "Ready for approved payments" : "Connect the payout account set up on this server"} icon={<WalletIcon />} />
      <CardBody className="space-y-4">
        {wallet?.address ? <>
          <KeyValue items={[
            {k: "Status", v: wallet.frozen ? "Paused" : live ? "Ready to pay" : "Not ready to pay yet"},
            {k: "Payment receipts", v: <Link href="/app/receipts">See receipts →</Link>},
          ]} />
          {manage && !wallet.frozen && <ActionButton action={toggleFreezeAction} label="Pause all payments" icon={<ShieldCheck />} />}
          <details className="text-[12px] text-ink-3"><summary className="cursor-pointer">Proof / technical details</summary>
            <div className="mt-2 space-y-2"><CopyField value={wallet.address} /><ExternalLink href={addressExplorerUrl("Celo", wallet.address)}>See it on Celoscan</ExternalLink> · <ExternalLink href={addressExplorerUrl("Celo", CELO.usdc)}>USDC token contract</ExternalLink><p>{CELO.name}, chain {CELO.chainId}.</p></div>
          </details>
        </> : <>
          <p className="text-sm text-ink-3">Connect the payout account configured on this server to this workspace.</p>
          {manage && <ActionButton action={provisionWalletAction} label="Connect configured payout account" icon={<WalletIcon />} />}
        </>}
      </CardBody>
    </Card>}
    {wallet?.provider === "altana" && <Card><CardHeader title="Your passkey wallet" description="You keep the money. GrowTendril's key can only spend up to your cap, until the date you chose." icon={<KeyRound />} />
      <CardBody>{altanaCard}</CardBody>
    </Card>}
    {!wallet && (otherOption
      ? <details className="rounded-[14px] border border-line bg-surface"><summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-[13px] font-medium text-ink"><KeyRound className="size-4 text-ink-3" /> Other option: passkey wallet</summary><div className="border-t border-line p-4">{altanaCard}<p className="mt-3 text-[12px] text-ink-3">A workspace keeps the first payout option you set up.</p></div></details>
      : <Card><CardHeader title="Passkey wallet" description="You keep the money. GrowTendril's key can only spend up to your cap." icon={<KeyRound />} /><CardBody>{altanaCard}</CardBody></Card>)}
    <UsdcHelp />
    {withdrawal && <Card><CardHeader title="Take money out" description="Owner only. We email you a code to confirm it." />
      <CardBody><p className="mb-4 text-sm text-ink-3">Available: {fmtUsdc(withdrawal.availableMicro)} after payments already approved. The network fee is paid separately in CELO.</p><WithdrawForm availableUsdc={String(withdrawal.availableMicro / 1e6)} explorer={CELO.explorer} /></CardBody>
    </Card>}
    <details className="rounded-[14px] border border-line bg-surface text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-[13px] font-medium text-ink"><Globe2 className="size-4 text-ink-3" /> Technical details</summary>
      <div className="space-y-4 border-t border-line p-4 text-ink-3">
        <div><div className="font-medium text-ink">Paying creators in their own currency</div><p className="mt-1">Choose naira, rupiah, reais or pesos on a creator&apos;s profile. Textile FX converts USD₮ into a local digital currency and GrowTendril delivers it. Every payment still needs your OK, and it counts as paid only after Celo shows the quoted amount reaching the creator. Available: {PAYOUT_TOKEN_KEYS.join(", ")}.</p></div>
        <div><div className="font-medium text-ink">Paid research</div><p className="mt-1">GrowTendril&apos;s research service only serves agents with a Self Agent ID, and limits apply per person. Payments use Celo&apos;s x402 facilitator, and each purchase keeps its sources and is matched to the USDC transfer. Agent identity: {process.env.CELO_AGENT_ID ? <>ERC-8004 agent #{process.env.CELO_AGENT_ID} on Celo</> : "not registered yet"}. Self verification: {process.env.SELF_AGENT_ENABLED === "1" ? "active" : "not active yet"}.</p></div>
        <p>Credit for scans is separate from this account. <Link className="underline" href="/billing">Go to Billing</Link></p>
        {owner && <p className="text-[11.5px] text-ink-4">Workspace ID <code className="num break-all">{project.id}</code></p>}
      </div>
    </details>
  </div>;
}
