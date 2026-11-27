"use client";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Fingerprint, Loader2, Wallet } from "lucide-react";
import type { Address, Hex } from "viem";
import { checkInvoiceAction, checkSentPaymentAction, payWithTxAction } from "@/server/actions/billing";
import { Button, Callout, Field, Input } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { keepValues } from "@/components/ui/submit";
import { toDataSuffix } from "@celo/attribution-tags";
import { balanceOfCalldata, transferCalldata } from "@/lib/erc20";
import { fmtUsdc } from "@/lib/money";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

/** The owner's Altana passkey wallet, when the selected workspace uses one. */
export interface AltanaPayer { address: string; balanceMicro: number | null }

export function PayInvoice(p: { invoiceId: string; payTo: string; amountMicro: number; usdc: string; chainId: number; rpcUrl: string; explorer: string; attributionCode: string | null; next: string; altana?: AltanaPayer | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<"waiting" | "sending" | "confirming" | "paid">("waiting");
  const [sentHash, setSentHash] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [state, action, pending] = useActionState(payWithTxAction.bind(null, p.invoiceId), null);
  const done = useRef(false);
  const mounted = useRef(true);
  const sending = useRef(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tag = p.attributionCode ? toDataSuffix(p.attributionCode).slice(2) : null;
  const calldata = `${transferCalldata(p.payTo, p.amountMicro)}${tag ?? ""}`;
  const altanaShort = p.altana && p.altana.balanceMicro != null && p.altana.balanceMicro < p.amountMicro ? p.amountMicro - p.altana.balanceMicro : 0;

  const finish = useCallback(() => {
    if (done.current || !mounted.current) return;
    done.current = true;
    setStatus("paid");
    toast.success("Payment confirmed on Celo", "The credit is on your balance.");
    redirectTimer.current = setTimeout(() => router.push(p.next), 1200);
  }, [router, p.next]);

  /** A sent payment that can never pay this invoice: say why and let the payer try again. */
  const failed = useCallback((message: string) => {
    if (done.current || !mounted.current) return;
    setSentHash(null);
    setStatus("waiting");
    setSendError(message);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  // Watch Celo every few seconds while the page is open: for any matching transfer, and for the
  // transaction this page sent, which may also fail onchain.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped || done.current) return;
      try {
        if (sentHash) {
          const sent = await checkSentPaymentAction(p.invoiceId, sentHash);
          if (stopped || done.current) return;
          if (sent.ok && sent.data?.state === "paid") return finish();
          if (sent.ok && sent.data?.state === "failed") return failed(sent.message ?? "That payment can't pay this invoice.");
          if (!sent.ok) setWatchError(sent.error);
        }
        const r = await checkInvoiceAction(p.invoiceId);
        if (stopped || done.current) return;
        if (r.ok && r.data?.paid) return finish();
        if (r.ok && r.data?.status === "expired") {
          setExpired(true);
          setWatchError("This invoice expired. If you already sent USDC, check its transaction hash below; otherwise create a new invoice from Billing.");
          return;
        }
        if (!sentHash) setWatchError(r.ok ? null : r.error);
      } catch {
        if (!stopped) setWatchError("Couldn’t check Celo right now. Checking will retry automatically; you can also verify your transaction below.");
      }
      if (!stopped && !done.current) timer = setTimeout(tick, sentHash ? 5000 : 6000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [p.invoiceId, sentHash, finish, failed]);

  useEffect(() => {
    if (state?.ok) finish();
  }, [state, finish]);

  const sent = (hash: string) => {
    setWatchError(null);
    setSentHash(hash);
    setStatus("confirming");
  };

  const payWithWallet = async () => {
    if (sending.current || sentHash || expired || done.current) return;
    const eth = window.ethereum;
    if (!eth) {
      toast.error("No browser wallet found", "Open this page inside a wallet app such as MiniPay, Valora or MetaMask, or send the USDC from any wallet using the details above.");
      return;
    }
    if (!tag) { toast.error("Payments are not configured", "The operator needs to configure the Celo attribution tag."); return; }
    let transactionRequested = false;
    try {
      sending.current = true;
      setSendError(null);
      setStatus("sending");
      const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!/^0x[0-9a-fA-F]{40}$/.test(from ?? "")) throw new Error("The wallet did not provide an account. Reconnect it and try again.");
      if (from.toLowerCase() === p.payTo.toLowerCase()) {
        setStatus("waiting");
        setSendError("Your wallet is connected with GrowTendril's billing address, so this payment would only send USDC to itself. Switch to the account you want to pay from, then try again.");
        return;
      }
      const chainHex = `0x${p.chainId.toString(16)}`;
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: chainHex, chainName: "Celo", nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 }, rpcUrls: [p.rpcUrl], blockExplorerUrls: [p.explorer] }],
        });
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      }
      const activeChain = await eth.request({ method: "eth_chainId" });
      if (typeof activeChain !== "string" || Number.parseInt(activeChain, 16) !== p.chainId) throw new Error("Switch your wallet to Celo before sending this payment.");
      // A transfer larger than the balance fails onchain and still costs the network fee. Check first;
      // if the balance can't be read, let the wallet decide.
      const raw = await eth.request({ method: "eth_call", params: [{ to: p.usdc, data: balanceOfCalldata(from) }, "latest"] }).catch(() => null);
      if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) {
        const balance = BigInt(raw);
        if (balance < BigInt(p.amountMicro)) {
          setStatus("waiting");
          setSendError(`This wallet has ${fmtUsdc(Number(balance))} on Celo, and this payment needs ${fmtUsdc(p.amountMicro)}. Add at least ${fmtUsdc(p.amountMicro - Number(balance))} of USDC on Celo to it, or pay from another wallet.`);
          return;
        }
      }
      if (!mounted.current || done.current) return;
      transactionRequested = true;
      const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to: p.usdc, data: calldata, value: "0x0" }] })) as string;
      if (!mounted.current || done.current) return;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        setStatus("confirming");
        toast.info("Check your wallet activity", "The wallet returned an unexpected reference. Automatic payment checking will continue; verify the transaction before sending again.");
        return;
      }
      sent(hash);
    } catch (e) {
      if (!mounted.current || done.current) return;
      const msg = (e as { message?: string }).message ?? String(e);
      const cancelled = (e as { code?: number }).code === 4001 || /reject|denied|cancel/i.test(msg);
      if (transactionRequested && !cancelled) {
        setStatus("confirming");
        toast.info("Payment status is unclear", "Check your wallet activity and verify its transaction hash below before sending again. Automatic checking will continue.");
      } else {
        setStatus("waiting");
        if (!cancelled) setSendError(`The wallet couldn’t send the payment: ${msg.slice(0, 200)}`);
      }
    } finally {
      sending.current = false;
    }
  };

  /** Pay from the owner's Altana wallet. The passkey signs; Altana's relay submits and charges its fee in CELO. */
  const payWithPasskey = async () => {
    if (sending.current || sentHash || expired || done.current || !p.altana) return;
    if (!tag) { toast.error("Payments are not configured", "The operator needs to configure the Celo attribution tag."); return; }
    let submitted = false;
    try {
      sending.current = true;
      setSendError(null);
      setStatus("sending");
      const { ownerFor } = await import("@/lib/altana-owner");
      const { sdk, client, owner } = await ownerFor(p.altana.address);
      if (!mounted.current || done.current) return;
      submitted = true;
      const result = await client.execute({ wallet: { address: p.altana.address as Address }, signer: owner.signer, calls: [{ to: p.usdc as Address, data: calldata as Hex }], feeToken: sdk.NATIVE_TOKEN });
      if (!mounted.current || done.current) return;
      if (result.status === "FAILED") throw new Error("Altana's relay reported that the payment failed. No USDC moved.");
      if (!result.transactionHash) {
        setStatus("confirming");
        toast.info("Payment submitted", "Altana hasn't reported the transaction yet. This page keeps checking Celo; don't pay again until it updates.");
        return;
      }
      sent(result.transactionHash);
    } catch (e) {
      if (!mounted.current || done.current) return;
      const msg = (e as { message?: string }).message ?? String(e);
      const cancelled = (e as { name?: string }).name === "NotAllowedError" || /reject|denied|cancel|not allowed/i.test(msg);
      if (submitted && !cancelled && !/failed/i.test(msg)) {
        setStatus("confirming");
        toast.info("Payment status is unclear", "Check the wallet's activity on Celo before paying again. Automatic checking will continue.");
      } else {
        setStatus("waiting");
        if (!cancelled) setSendError(msg.slice(0, 240));
      }
    } finally {
      sending.current = false;
    }
  };

  if (status === "paid") {
    return (
      <Callout tone="success" title="Payment confirmed">
        Credit added to your balance. Taking you to {p.next === "/billing" ? "billing" : "your workspace"}…
      </Callout>
    );
  }

  const busy = status === "sending" || status === "confirming";
  return (
    <div className="space-y-5">
      {sendError && <Callout tone="danger" title="Payment not made">{sendError}</Callout>}
      {p.altana && (
        <div className="space-y-3 rounded-[14px] border border-line bg-surface-2 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Fingerprint className="size-4" /> Pay from your Altana wallet</div>
          <p className="text-[12px] leading-relaxed text-ink-3">
            You hold this wallet&apos;s keys, so you approve the payment with your passkey. Altana&apos;s small network fee is paid in CELO from the same wallet.
          </p>
          <p className="text-[12px] text-ink-2">
            Wallet <span className="num">{p.altana.address.slice(0, 6)}…{p.altana.address.slice(-4)}</span> · Balance: <span className="num">{p.altana.balanceMicro == null ? "couldn’t read" : fmtUsdc(p.altana.balanceMicro)}</span>
          </p>
          {altanaShort > 0 && <Callout tone="warn">Add at least {fmtUsdc(altanaShort)} of USDC to this wallet, or pay from another wallet below.</Callout>}
          <Button type="button" variant="secondary" icon={busy ? <Loader2 className="animate-spin" /> : <Fingerprint />} disabled={expired || busy || altanaShort > 0} onClick={payWithPasskey}>
            {status === "sending" ? "Approve with your passkey…" : `Pay ${fmtUsdc(p.amountMicro)} with passkey`}
          </Button>
        </div>
      )}
      <Button variant="primary" size="lg" className="w-full" icon={busy ? <Loader2 className="animate-spin" /> : <Wallet />} disabled={expired || status !== "waiting"} onClick={payWithWallet}>
        {expired ? "Invoice expired" : status === "sending" ? "Confirm in your wallet…" : status === "confirming" ? "Payment sent — checking Celo…" : "Pay from my wallet"}
      </Button>
      {sentHash && (
        <p className="text-center text-[12px] text-ink-3">
          Sent:{" "}
          <a href={`${p.explorer}/tx/${sentHash}`} target="_blank" rel="noreferrer" className="num underline">
            {sentHash.slice(0, 10)}…{sentHash.slice(-6)}
          </a>
        </p>
      )}
      {watchError && <Callout tone="warn">{watchError}</Callout>}
      {!expired && <div role="status" className="flex items-center gap-2 rounded-[8px] border border-line bg-bg/40 px-3 py-2.5 text-[12.5px] text-ink-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-ink-4" />
        {sentHash ? "Waiting for Celo to confirm your payment — this page updates by itself." : "Watching Celo for your payment — this page updates by itself."}
      </div>}
      <form action={action} onSubmit={keepValues(action)} className="space-y-2.5">
        <Field label="Already sent it from another wallet?" htmlFor="pay-tx" hint="Paste the transaction hash and we'll check it on Celo right away.">
          <Input id="pay-tx" name="txHash" required pattern="0x[0-9a-fA-F]{64}" minLength={66} maxLength={66} placeholder="0x…" spellCheck={false} autoComplete="off" className="num text-[12px]" />
        </Field>
        {state && !state.ok && <Callout tone="danger">{state.error}</Callout>}
        <Button type="submit" variant="secondary" loading={pending} icon={<CheckCircle2 />} className="w-full">
          Check transaction
        </Button>
      </form>
    </div>
  );
}
