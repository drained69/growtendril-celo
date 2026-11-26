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
import { WithdrawForm } from "@/components/features/wallet/withdraw-form";
import { withdrawable } from "@/server/domain/agent/withdraw";
import { exceptionsFor } from "@/server/domain/reconcile/exceptions";
import { spentTodayMicro } from "@/server/queries/activity";
import { activeMission, missionSummary } from "@/server/queries/missions";
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
  const summary = mission ? await missionSummary(db, mission) : null;
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
  return <div className="space-y-4">
    <PageHeader title="Payout account" description="The money that pays people, such as creators. It stays in an account only you control, and we ask you before paying any person."
      actions={<ActionButton action={refreshSettlementsAction} label="Check for payment updates" icon={<RefreshCw />} />} />
    <UsdcHelp />
    <StatStrip className="grid-cols-2 lg:grid-cols-4">
      <Stat label={contract ? "Contract USDC" : "Wallet USDC"} value={usdcHeld == null ? "—" : fmtUsdc(Number(usdcHeld))} sub={contract ? `${usdtHeld ? fmtUsdc(Number(usdtHeld)).replace("USDC", "USD₮") : "0 USD₮"} for local payouts` : wallet ? "Celo balance" : "No wallet yet"} />
      <Stat label="Spent today" value={fmtUsdc(spent)} sub={`Daily limit ${fmtUsdc(policy?.dailySpendMicro ?? 0)}`} />
      <Stat label="Per-payment limit" value={policy ? fmtUsdc(effectivePaymentCeiling(policy)) : "—"} sub={<Link className="underline" href="/app/settings">Change in Settings</Link>} />
      <Stat label="Mission remaining" value={mission && summary ? fmtUsdc(mission.budgetMicro - summary.spent) : "—"} sub="After committed spend" />
    </StatStrip>
    {issue && <Callout tone="warn" title="Agent wallet setup incomplete">{issue}</Callout>}
    {!!balances.errors.length && <Callout tone="warn" title="Balance unavailable">{balances.errors.join(" · ")}</Callout>}
    {wallet?.frozen && <Callout tone="danger" title="Spending is frozen" action={manage && !contract ? <ActionButton action={toggleFreezeAction} label="Resume spending" icon={<Unlock />} /> : undefined}>{contract ? "Every payment is refused until you resume spending in your workspace contract below." : "Every spend is denied until a wallet manager resumes it."}</Callout>}
    <LedgerExceptions items={exceptions} canResolve={manage} />
    {!wallet && protocol && <Callout tone="info" title="Choose how this workspace pays">Most teams use a workspace contract: your own wallet owns it, and the agent can only act inside your rules. You can instead keep funds in an Altana passkey wallet. A workspace keeps the first wallet you link.</Callout>}
    {protocol && (!wallet || contract) && <Card><CardHeader title="Your workspace contract" description="Your budget, limits, approvals and payouts, enforced on Celo mainnet" icon={<Landmark />} />
      <CardBody><WorkspaceContract view={protocol} canManage={manage} /></CardBody>
    </Card>}
    {showServerWallet && <Card><CardHeader title="Workspace wallet" description={live ? "Celo wallet ready for approved payments" : "Attach a dedicated wallet to this workspace"} icon={<WalletIcon />} />
      <CardBody className="space-y-4">
        {wallet?.address ? <>
          <CopyField value={wallet.address} />
          <ExternalLink href={addressExplorerUrl("Celo", wallet.address)}>View on Celoscan</ExternalLink>
          <KeyValue items={[
            {k: "Network", v: CELO.name}, {k: "Status", v: wallet.frozen ? "Paused" : live ? "Ready to pay" : "Not ready to pay yet"},
            {k: "USDC", v: <ExternalLink href={addressExplorerUrl("Celo", CELO.usdc)}>Token contract</ExternalLink>},
            {k: "Payment receipts", v: <Link href="/app/receipts">Review receipts →</Link>},
          ]} />
          {manage && !wallet.frozen && <ActionButton action={toggleFreezeAction} label="Freeze spending" icon={<ShieldCheck />} />}
        </> : <>
          <p className="text-sm text-ink-3">Attach the agent wallet configured on this server to this workspace.</p>
          {manage && <ActionButton action={provisionWalletAction} label="Attach configured Celo wallet" icon={<WalletIcon />} />}
        </>}
      </CardBody>
    </Card>}
    {(!wallet || wallet.provider === "altana") && <Card><CardHeader title={wallet ? "Your Altana wallet" : "Or use an Altana passkey wallet"} description="You keep custody. Celo enforces the agent's spend cap, allowed contracts and expiry." icon={<KeyRound />} />
      <CardBody><AltanaWallet address={wallet?.address ?? null} canManage={manage} workspaceName={project.name} session={session ? {id: session.id, publicKey: session.publicKey, capUsd: fmtUsdc(session.capMicro), period: session.period, expiresAt: session.expiresAt.toISOString(), grantTxHash: session.grantTxHash, revokeTxHash: session.revokeTxHash} : null} /></CardBody>
    </Card>}
    <Card><CardHeader title="Pay creators in their currency" description="Textile FX converts USD₮ to a local stablecoin, then the agent delivers it" icon={<Globe2 />} />
      <CardBody className="space-y-3 text-sm text-ink-3">
        <p>Choose naira, rupiah, reais or pesos on a creator’s profile. Every payment still needs your approval, and it counts as settled only after Celo shows the quoted amount reaching that creator.</p>
        <p>Available: {PAYOUT_TOKEN_KEYS.join(", ")}.</p>
      </CardBody>
    </Card>
    <Card><CardHeader title="Verified payments" description="Paid research with proof that a real person stands behind an agent" icon={<ShieldCheck />} />
      <CardBody className="space-y-3 text-sm text-ink-3">
        <p>GrowTendril’s research service requires Self Agent ID before it offers a paid request, and limits use per person across their agents. Payments use Celo’s x402 facilitator. Each purchase retains its source evidence and is reconciled against the USDC transfer.</p>
        <p>Agent identity: {process.env.CELO_AGENT_ID ? <>ERC-8004 agent #{process.env.CELO_AGENT_ID} on Celo</> : "not registered yet"}. Self verification: {process.env.SELF_AGENT_ENABLED === "1" ? "active" : "not active yet"}.</p>
        <p>Prepaid scan credit is separate from wallet funds. <Link className="underline" href="/billing">Manage Billing</Link></p>
      </CardBody>
    </Card>
    {withdrawal && <Card><CardHeader title="Withdraw USDC" description="Owner only; confirmed with an emailed code and an onchain receipt" />
      <CardBody><p className="mb-4 text-sm text-ink-3">Available: {fmtUsdc(withdrawal.availableMicro)} after committed payments. Network gas uses CELO separately.</p><WithdrawForm availableUsdc={String(withdrawal.availableMicro / 1e6)} explorer={CELO.explorer} /></CardBody>
    </Card>}
    {owner && <p className="text-[11.5px] text-ink-4">Workspace ID <code className="num break-all">{project.id}</code></p>}
  </div>;
}
