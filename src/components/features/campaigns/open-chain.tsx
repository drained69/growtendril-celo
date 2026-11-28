"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseAbi, type Abi, type Address, type Hex } from "viem";
import { Button, Input } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { celoReader, connectCelo, sendCelo, walletError } from "@/lib/celo-browser";
import { fmtUsdc } from "@/lib/money";
import { CAMPAIGN_ESCROW_ABI, CELO_USDC, isCampaignEscrowCode, OPEN_HOLD_SECONDS, OPEN_REVIEW_WINDOW_SECONDS, ZERO_ADDRESS, openCampaignKey, openReasonHash } from "@/lib/open-campaigns";
import {
  confirmOpenAgentAction, confirmOpenFundingAction, confirmOpenObjectionAction, confirmOpenRefundAction, prepareOpenFundingAction, syncMyClaimAction, syncOwnerClaimAction,
} from "@/server/actions/open-campaigns";

const ERC20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);
const escrowAbi = CAMPAIGN_ESCROW_ABI as unknown as Abi;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Checks, in the browser and before any money moves, that the address really is the campaign contract. */
export async function checkCampaignContract(contract: Address) {
  const code = await celoReader.getCode({ address: contract });
  if (!code || !isCampaignEscrowCode(code)) throw new Error("This address doesn't hold GrowTendril's reviewed campaign contract. Nothing was sent.");
  const [token, hold, window] = await Promise.all([
    celoReader.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "token" }),
    celoReader.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "refundHold" }),
    celoReader.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "REVIEW_WINDOW" }),
  ]);
  if (!same(token, CELO_USDC) || hold !== BigInt(OPEN_HOLD_SECONDS) || window !== BigInt(OPEN_REVIEW_WINDOW_SECONDS))
    throw new Error("This contract doesn't match GrowTendril's campaign contract. Nothing was sent.");
}

function Hash({ hash }: { hash: string | null }) {
  return hash ? <a className="block break-all text-xs underline" href={`https://celoscan.io/tx/${hash}`} target="_blank" rel="noopener noreferrer">See it on Celoscan</a> : null;
}

/** Owner: approve the exact amount, then create the campaign in the contract. Two wallet prompts. */
export function FundOpenCampaign({ programId, totalMicro }: { programId: string; totalMicro: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [step, setStep] = useState(""), [hash, setHash] = useState<string | null>(null), [error, setError] = useState("");
  async function run() {
    setBusy(true); setError(""); setHash(null);
    let sent: string | null = null;
    try {
      setStep("Getting the campaign terms ready…");
      const prepared = await prepareOpenFundingAction(programId);
      if (!prepared.ok) throw new Error(prepared.error);
      const p = prepared.data!;
      setStep("Connecting your wallet…");
      const { account } = await connectCelo();
      setStep("Checking the campaign contract…");
      await checkCampaignContract(p.contract);
      const key = openCampaignKey(account, p.salt);
      const existing = await celoReader.readContract({ address: p.contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "campaigns", args: [key] });
      if (existing[0] === ZERO_ADDRESS) {
        const budget = BigInt(p.budgetMicro);
        const balance = await celoReader.readContract({ address: CELO_USDC, abi: ERC20, functionName: "balanceOf", args: [account] });
        if (balance < budget) throw new Error(`This wallet has ${fmtUsdc(Number(balance))} in USDC. It needs ${fmtUsdc(p.budgetMicro)}. Add USDC (digital dollars) to it, then try again.`);
        if (Date.now() / 1000 >= p.deadline) throw new Error("The end date has passed. Reload the page to set a new one.");
        const allowance = await celoReader.readContract({ address: CELO_USDC, abi: ERC20, functionName: "allowance", args: [account, p.contract] });
        if (allowance < budget) {
          setStep(`Step 1 of 2: allow the contract to take exactly ${fmtUsdc(p.budgetMicro)}. Confirm in your wallet.`);
          sent = await sendCelo({ address: CELO_USDC, abi: ERC20 as unknown as Abi, functionName: "approve", args: [p.contract, budget], attribution: p.attribution });
          setHash(sent);
        }
        setStep(`Step 2 of 2: set ${fmtUsdc(p.budgetMicro)} aside for this campaign. Confirm in your wallet.`);
        sent = await sendCelo({ address: p.contract, abi: escrowAbi, functionName: "createCampaign", args: [p.salt, p.agent, BigInt(p.deadline), budget, BigInt(p.baseMicro), 0n, 0n, 0n, BigInt(p.slots), p.termsHash], attribution: p.attribution });
        setHash(sent);
      }
      setStep("Checking Celo…");
      let saved = await confirmOpenFundingAction(programId, account, sent);
      for (let i = 0; !saved.ok && i < 3; i++) { await new Promise(r => setTimeout(r, 4000)); saved = await confirmOpenFundingAction(programId, account, sent); }
      if (!saved.ok) throw new Error(saved.error);
      toast.success(saved.message ?? "Your campaign is open");
      router.push(`/app/campaigns/${programId}`); router.refresh();
    } catch (e) {
      setError(sent ? `${walletError(e)} The money may already be on Celo; reload this page and press the button again. It won't be charged twice.` : walletError(e));
    } finally { setBusy(false); setStep(""); }
  }
  return <div className="space-y-3">
    <Button variant="primary" loading={busy} onClick={run}>Set aside {fmtUsdc(totalMicro)} and open the campaign</Button>
    {step && <p role="status" className="text-sm text-ink-2">{step}</p>}
    {error && <p role="alert" className="text-sm text-critical">{error}</p>}
    <Hash hash={hash} />
  </div>;
}

type OwnerKind = "object" | "queue" | "removeAgent" | "restoreAgent" | "refund";
/**
 * Owner actions that only the funding wallet can do on Celo. Each sends one transaction from the
 * owner's own wallet, then asks the server to read Celo and record the result.
 */
export function OwnerChainButton(props: {
  kind: OwnerKind; programId: string; contract: string; campaignId: string; ownerAddress: string; attribution: Hex | null; label: string;
  claimId?: string; rewardId?: string; recipient?: string; evidenceHash?: string; agent?: string | null; variant?: "primary" | "secondary" | "ghost" | "danger";
  confirmText?: string; disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [reason, setReason] = useState(""), [asking, setAsking] = useState(false), [error, setError] = useState(""), [hash, setHash] = useState<string | null>(null);
  async function run() {
    if (props.kind === "object" && reason.trim().length < 5) { setError("Tell the person why, in a few words"); return; }
    if (props.confirmText && !window.confirm(props.confirmText)) return;
    setBusy(true); setError("");
    let sent: string | null = null;
    try {
      const contract = props.contract as Address, id = props.campaignId as Hex;
      const { account } = await connectCelo();
      if (!same(account, props.ownerAddress)) throw new Error(`Switch to the wallet that set the money aside (${props.ownerAddress.slice(0, 6)}…${props.ownerAddress.slice(-4)}).`);
      await checkCampaignContract(contract);
      const call = props.kind === "object" ? { functionName: "object", args: [id, props.rewardId, openReasonHash(reason)] }
        : props.kind === "queue" ? { functionName: "queueReward", args: [id, props.rewardId, props.recipient, 0n, 0n, props.evidenceHash] }
        : props.kind === "removeAgent" ? { functionName: "setAgent", args: [id, ZERO_ADDRESS] }
        : props.kind === "restoreAgent" ? { functionName: "setAgent", args: [id, props.agent] }
        : { functionName: "refundUnused", args: [id] };
      sent = await sendCelo({ address: contract, abi: escrowAbi, attribution: props.attribution, ...call });
      setHash(sent);
      const record = () => props.kind === "object" ? confirmOpenObjectionAction(props.programId, props.claimId!, reason, sent)
        : props.kind === "queue" ? syncOwnerClaimAction(props.programId, props.claimId!)
        : props.kind === "refund" ? confirmOpenRefundAction(props.programId, sent)
        : confirmOpenAgentAction(props.programId);
      let saved = await record();
      for (let i = 0; !saved.ok && i < 3; i++) { await new Promise(r => setTimeout(r, 4000)); saved = await record(); }
      if (!saved.ok) throw new Error(saved.error);
      toast.success(saved.message ?? "Done");
      setAsking(false); router.refresh();
    } catch (e) {
      setError(sent ? `${walletError(e)} The transaction was sent; reload the page in a minute.` : walletError(e));
    } finally { setBusy(false); }
  }
  if (props.kind === "object" && !asking) return <Button size="xs" variant="danger" disabled={props.disabled} onClick={() => setAsking(true)}>{props.label}</Button>;
  return <div className="space-y-2">
    {props.kind === "object" && <Input aria-label="Why you object" placeholder="Why? The person will see this." value={reason} maxLength={300} onChange={e => setReason(e.target.value)} disabled={busy} />}
    <div className="flex flex-wrap gap-2">
      <Button size="xs" variant={props.variant ?? (props.kind === "object" ? "danger" : "secondary")} loading={busy} disabled={props.disabled} onClick={run}>{props.kind === "object" ? "Object in your wallet" : props.label}</Button>
      {props.kind === "object" && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>}
    </div>
    {error && <p role="alert" className="text-xs text-critical">{error}</p>}
    <Hash hash={hash} />
  </div>;
}

/** Participant: anyone can send a reward once the hold is over. This sends it from their own wallet. */
export function CollectButton({ claimId, contract, campaignId, rewardId, attribution }: { claimId: string; contract: string; campaignId: string; rewardId: string; attribution: Hex | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function run() {
    setBusy(true); setError("");
    try {
      await checkCampaignContract(contract as Address);
      await sendCelo({ address: contract as Address, abi: escrowAbi, functionName: "claim", args: [campaignId, rewardId], attribution });
      const saved = await syncMyClaimAction(claimId);
      if (!saved.ok) throw new Error(saved.error);
      toast.success("Paid to your wallet"); router.refresh();
    } catch (e) { setError(walletError(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-1"><Button size="sm" variant="primary" loading={busy} onClick={run}>Collect now</Button>{error && <p role="alert" className="text-xs text-critical">{error}</p>}</div>;
}

/** Time left to object, ticking each minute. */
export function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  if (now === null) return <span>{new Date(until).toUTCString().slice(5, 22)} UTC</span>;
  const left = new Date(until).getTime() - now;
  if (left <= 0) return <span>hold over</span>;
  const d = Math.floor(left / 86_400_000), h = Math.floor(left / 3_600_000) % 24, m = Math.floor(left / 60_000) % 60;
  return <span>{d ? `${d}d ` : ""}{h}h {m}m left</span>;
}
