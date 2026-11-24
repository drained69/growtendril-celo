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
    ? `Approve on Celo mainnet?\n\nSpend up to: ${spend} USD₮\nRecipient: ${intent.recipient}\nThey receive at least: ${formatPayout(local, intent.minPayout)}`
    : `Approve on Celo mainnet?\n\nPay: ${spend} USDC\nRecipient: ${intent.recipient}`;
}
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { AgentLog } from "@/components/features/agent/agent-log";

type Log = { agent: string; message: string }[];

/** Approve (optionally at a reduced amount) or reject one spend approval. Server re-checks deny rules. */
export function ApprovalControls({ id, requested, onchain = false, attribution = null }: { id: string; requested: string; onchain?: boolean; attribution?: Hex | null }) {
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
    if (resolution === "reject" && !window.confirm("Reject this spend? The agent will not retry it.")) return;
    setWhich(resolution);
    start(async () => {
      setError(null);
      if (onchain) {
        try {
          if (resolution === "approve") {
            const prepared = await prepareVaultApprovalAction(id, reduced ? amount.trim() : undefined);
            if (!prepared.ok || !prepared.data) throw new Error(prepared.ok ? "This payment could not be prepared" : prepared.error);
            // Read the terms from Celo, not the app, so the approver sees exactly what the contract will pay.
            const intent = await celoReader.readContract({ address: prepared.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI, functionName: "intentOf", args: [prepared.data.intentId] });
            if (!window.confirm(describeIntent(intent))) { setWhich(null); return; }
            if (prepared.data.needsSignature) await sendCelo({ address: prepared.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI as Abi, functionName: "approve", args: [prepared.data.intentId], attribution });
          } else {
            const open = await openVaultIntentsAction(id, reduced ? amount.trim() : undefined);
            if (!open.ok || !open.data) throw new Error(open.ok ? "This payment could not be checked" : open.error);
            if (open.data.intentIds.length) await sendCelo({ address: open.data.workspace as Address, abi: GROWTH_WORKSPACE_ABI as Abi, functionName: "rejectMany", args: [open.data.intentIds], attribution });
          }
        } catch (e) {
          const message = walletError(e);
          setError(message);
          toast.error(resolution === "approve" ? "Payment not approved" : "Payment not rejected", message);
          setWhich(null);
          return;
        }
      }
      const r = await resolveApprovalAction(id, resolution, resolution === "approve" && reduced ? amount.trim() : undefined, note.trim() || undefined);
      if (!r.ok) {
        setError(r.error);
        toast.error("Couldn’t resolve approval", r.error);
      } else {
        toast.success(r.message ?? (resolution === "approve" ? "Approved" : "Rejected"));
        if (r.log?.length) setLog(r.log);
      }
      setWhich(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {modify && (
        <Field label="Approved amount" htmlFor={`amt-${id}`} error={invalid ? `Enter a positive amount up to ${requested} USDC` : null} hint={`Requested ${requested} USDC — you can only reduce it.`}>
          <div className="relative">
            <Input id={`amt-${id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num pr-12" disabled={pending} />
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-ink-4">USDC</span>
          </div>
        </Field>
      )}
      <Field label="Note" htmlFor={`note-${id}`} hint="Optional — stored on the decision receipt.">
        <Textarea id={`note-${id}`} rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why you approved or rejected" disabled={pending} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Check />} loading={pending && which === "approve"} disabled={pending || invalid} onClick={() => go("approve")}>
          {onchain ? (reduced ? `Sign approval for ${amount.trim()} USDC` : "Sign approval in wallet") : reduced ? `Approve ${amount.trim()} USDC` : "Approve & execute"}
        </Button>
        <Button variant="danger" icon={<X />} loading={pending && which === "reject"} disabled={pending} onClick={() => go("reject")}>
          Reject
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
          {modify ? "Keep requested" : "Reduce amount"}
        </Button>
      </div>
      {error && <p className="text-[11.5px] text-critical">{error}</p>}
      <Dialog open={!!log} onClose={() => setLog(null)} title="What happened" description="Each line is a step the agents took after your decision." size="lg">
        <AgentLog log={log ?? []} />
      </Dialog>
    </div>
  );
}
