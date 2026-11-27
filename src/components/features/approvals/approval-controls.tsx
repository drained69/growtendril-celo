"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";
import type { Abi, Address, Hex } from "viem";
import { resolveApprovalAction } from "@/server/actions/approvals";
import { openVaultIntentsAction, prepareVaultApprovalAction } from "@/server/actions/protocol";
import { GROWTH_WORKSPACE_ABI } from "@/lib/celo-protocol-abi";
import { celoReader, sendCelo, walletError } from "@/lib/celo-browser";
import { formatPayout, PAYOUT_TOKEN_KEYS, PAYOUT_TOKENS } from "@/server/integrations/celo/corridors";

function describeIntent(intent: { recipient: string; amount: bigint; payoutToken: string; minPayout: bigint }) {
  const spend = (Number(intent.amount) / 1e6).toFixed(2);
  const local = PAYOUT_TOKEN_KEYS.find((key) => PAYOUT_TOKENS[key].address.toLowerCase() === intent.payoutToken.toLowerCase());
  return local
    ? `Pay this from your Payout account?\n\nUp to: ${spend} USD₮\nTo: ${intent.recipient}\nThey get at least: ${formatPayout(local, intent.minPayout)}`
    : `Pay this from your Payout account?\n\nAmount: ${spend} USDC\nTo: ${intent.recipient}`;
}
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { AgentLog } from "@/components/features/agent/agent-log";

type Log = { agent: string; message: string }[];

/** Pay (optionally a smaller amount) or don't pay one request. The server re-checks every limit. */
export function ApprovalControls({ id, requested, payee = null, onchain = false, attribution = null }: { id: string; requested: string; payee?: string | null; onchain?: boolean; attribution?: Hex | null }) {
  const [amount, setAmount] = useState(requested);
  const [modify, setModify] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "reject" | null>(null);
  const router = useRouter();

  const reduced = modify && amount.trim() !== "" && amount.trim() !== requested;
  const invalid = modify && (!/^\d{1,7}(\.\d{1,6})?$/.test(amount.trim()) || Number(amount) <= 0 || Number(amount) > Number(requested));

  const go = (resolution: "approve" | "reject") => {
    if (resolution === "reject" && !window.confirm("Don't pay this? GrowTendril won't ask again for this payment.")) return;
    setWhich(resolution);
    start(async () => {
      setError(null);
      if (onchain) {
        try {
          if (resolution === "approve") {
            const prepared = await prepareVaultApprovalAction(id, reduced ? amount.trim() : undefined);
            if (!prepared.ok || !prepared.data) throw new Error(prepared.ok ? "We couldn't get this payment ready. Refresh the page and try again." : prepared.error);
            // Read the terms from Celo, not the app, so the approver sees exactly what the contract will pay.
            const intent = await celoReader.readContract({ address: prepared.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI, functionName: "intentOf", args: [prepared.data.intentId] });
            if (!window.confirm(describeIntent(intent))) { setWhich(null); return; }
            if (prepared.data.needsSignature) await sendCelo({ address: prepared.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI as Abi, functionName: "approve", args: [prepared.data.intentId], attribution });
          } else {
            const open = await openVaultIntentsAction(id, reduced ? amount.trim() : undefined);
            if (!open.ok || !open.data) throw new Error(open.ok ? "We couldn't check this payment. Refresh the page and try again." : open.error);
            if (open.data.intentIds.length) await sendCelo({ address: open.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI as Abi, functionName: "rejectMany", args: [open.data.intentIds], attribution });
          }
        } catch (e) {
          const message = walletError(e);
          setError(message);
          toast.error(resolution === "approve" ? "Not paid" : "Still waiting", message);
          setWhich(null);
          return;
        }
      }
      const r = await resolveApprovalAction(id, resolution, resolution === "approve" && reduced ? amount.trim() : undefined, note.trim() || undefined);
      if (!r.ok) {
        setError(r.error);
        toast.error("That didn't go through", r.error);
      } else {
        toast.success(r.message ?? (resolution === "approve" ? "Paid" : "Not paid"));
        if (r.log?.length) setLog(r.log);
      }
      setWhich(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {modify && (
        <Field label="Pay this much instead" htmlFor={`amt-${id}`} error={invalid ? `Enter an amount above 0 and up to ${requested} USDC` : null} hint={`Asked for ${requested} USDC — you can only pay less.`}>
          <div className="relative">
            <Input id={`amt-${id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num pr-12" disabled={pending} />
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-ink-4">USDC</span>
          </div>
        </Field>
      )}
      <Field label="Note (optional)" htmlFor={`note-${id}`} hint="Kept on the receipt.">
        <Textarea id={`note-${id}`} rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why you paid or didn't" disabled={pending} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Check />} loading={pending && which === "approve"} disabled={pending || invalid} onClick={() => go("approve")}>
          {`Pay ${payee ? `${payee} ` : ""}${reduced ? amount.trim() : requested} USDC`}{onchain ? " (confirm in wallet)" : ""}
        </Button>
        <Button variant="danger" icon={<X />} loading={pending && which === "reject"} disabled={pending} onClick={() => go("reject")}>
          Don&apos;t pay
        </Button>
        <Button
          variant="ghost"
          icon={<Pencil />}
          disabled={pending}
          onClick={() => {
            setModify((m) => !m);
            setAmount(requested);
          }}
        >
          {modify ? "Pay the full amount" : "Pay less"}
        </Button>
      </div>
      {error && <p className="text-[11.5px] text-critical">{error}</p>}
      <Dialog open={!!log} onClose={() => setLog(null)} title="What happened" description="Each line is a step GrowTendril took after your decision." size="lg">
        <AgentLog log={log ?? []} />
      </Dialog>
    </div>
  );
}
