"use client";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { keepValues } from "@/components/ui/submit";
import type { ActionResult } from "@/server/actions/_common";
import { createOpenCampaignAction, joinOpenCampaignAction, openAgreementAction, rejectOpenClaimAction, submitOpenClaimAction } from "@/server/actions/open-campaigns";
import { OPEN_LIMITS, PROOF_KINDS, PROOF_LABEL } from "@/lib/open-campaigns";
import { connectCelo, walletError } from "@/lib/celo-browser";

type FormAction = (previous: unknown, form: FormData) => Promise<ActionResult>;
function ActionForm({ action: server, children, label, variant = "primary", size }: { action: FormAction; children: ReactNode; label: string; variant?: "primary" | "secondary" | "danger"; size?: "xs" | "sm" | "md" }) {
  const [state, action, pending] = useActionState(server, null);
  const router = useRouter();
  useEffect(() => {
    if (!state?.ok) return;
    toast.success(state.message ?? "Saved");
    const url = (state.data as { url?: string } | undefined)?.url;
    if (url) router.push(url);
    router.refresh();
  }, [state, router]);
  return <form action={action} onSubmit={keepValues(action)} className="space-y-3">
    <fieldset disabled={pending} className="space-y-3">{children}<Button type="submit" variant={variant} size={size} loading={pending}>{label}</Button></fieldset>
    {state && !state.ok && <p role="alert" className="text-sm text-critical">{state.error}</p>}
  </form>;
}

export function NewOpenCampaignForm() {
  const [reward, setReward] = useState("2"), [people, setPeople] = useState("10");
  const total = (Number(reward) || 0) * (Number(people) || 0);
  const tooMuch = total > OPEN_LIMITS.maxTotalMicro / 1e6 || Number(reward) > OPEN_LIMITS.maxRewardMicro / 1e6;
  return <ActionForm action={createOpenCampaignAction} label="Save and continue">
    <Field label="Campaign name" htmlFor="oc-title" hint="People see this on the campaign page."><Input id="oc-title" name="title" required minLength={3} maxLength={80} placeholder="Tell your friends about our bakery" /></Field>
    <Field label="What should people do?" htmlFor="oc-task" hint="Be specific. For example: post a photo of your order and say what you liked."><Textarea id="oc-task" name="task" rows={4} required minLength={20} maxLength={1500} placeholder="Post about your visit to our shop with a photo, and say what you liked." /></Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="How do they prove it?" htmlFor="oc-proof"><Select id="oc-proof" name="proofKind" defaultValue="x">{PROOF_KINDS.map(k => <option key={k} value={k}>{PROOF_LABEL[k]}</option>)}</Select></Field>
      <Field label="Words the post must include (optional)" htmlFor="oc-text" hint="For example #ad, so readers know it's paid."><Input id="oc-text" name="requiredText" maxLength={40} placeholder="#ad" /></Field>
      <Field label="Reward per person (USDC)" htmlFor="oc-reward" hint="USDC is a digital dollar: 1 USDC = $1."><Input id="oc-reward" name="reward" inputMode="decimal" required value={reward} onChange={e => setReward(e.target.value)} pattern="^\d+(\.\d{1,6})?$" /></Field>
      <Field label="How many people" htmlFor="oc-people"><Input id="oc-people" name="people" type="number" min={1} max={OPEN_LIMITS.maxPeople} step={1} required value={people} onChange={e => setPeople(e.target.value)} /></Field>
      <Field label="Ends in (days)" htmlFor="oc-days" hint="The end date is fixed when you set the money aside."><Input id="oc-days" name="days" type="number" min={1} max={OPEN_LIMITS.maxDays} step={1} required defaultValue={14} /></Field>
    </div>
    <div aria-live="polite" className="rounded-2xl border border-line p-4 text-sm space-y-1.5">
      <p>You&apos;ll set aside <strong>${total.toFixed(2)}</strong> in USDC from your own wallet.</p>
      <p className="text-xs text-ink-3">Each spot pays one person once. GrowTendril checks every claim and you can object to any approved reward for 3 days before it&apos;s paid. Money nobody earned comes back to you 7 days after the campaign ends.</p>
      {tooMuch && <p className="text-critical">For now a campaign can set aside at most ${OPEN_LIMITS.maxTotalMicro / 1e6} and pay at most ${OPEN_LIMITS.maxRewardMicro / 1e6} per person.</p>}
    </div>
  </ActionForm>;
}

export function ProofForm({ participantId, label = "Send my proof", placeholder }: { participantId: string; label?: string; placeholder: string }) {
  return <ActionForm action={submitOpenClaimAction.bind(null, participantId)} label={label}>
    <Field label="Link to your post" htmlFor={`proof-${participantId}`} hint="It must be public, so we can open it without signing in."><Input id={`proof-${participantId}`} name="url" type="url" required placeholder={placeholder} /></Field>
  </ActionForm>;
}

/** Owner: turn down a claim (or object to an approved one not yet on Celo), with a reason the person sees. */
export function RejectClaimForm({ programId, claimId, label }: { programId: string; claimId: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>{label}</Button>;
  return <ActionForm action={rejectOpenClaimAction.bind(null, programId, claimId)} label={label} variant="danger" size="xs">
    <Input aria-label="Reason" name="reason" required minLength={5} maxLength={300} placeholder="Why? The person will see this." />
  </ActionForm>;
}

/** Participant: connect the payout wallet, sign the plain agreement (free), and join. */
export function JoinOpenCampaign({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [step, setStep] = useState(""), [error, setError] = useState(""), [preview, setPreview] = useState("");
  async function run() {
    setBusy(true); setError("");
    try {
      setStep("Connecting your wallet…");
      const { wallet, account } = await connectCelo();
      const agreement = await openAgreementAction(slug, account);
      if (!agreement.ok) throw new Error(agreement.error);
      setPreview(agreement.data!.message);
      setStep("Sign the agreement in your wallet. It's free and moves no money.");
      const signature = await wallet.signMessage({ account, message: agreement.data!.message });
      setStep("Saving…");
      const joined = await joinOpenCampaignAction(slug, account, agreement.data!.issuedAt, signature);
      if (!joined.ok) throw new Error(joined.error);
      toast.success(joined.message ?? "You've joined");
      router.refresh();
    } catch (e) { setError(walletError(e)); }
    finally { setBusy(false); setStep(""); }
  }
  return <div className="space-y-3">
    <Button variant="primary" loading={busy} onClick={run}>Connect wallet and agree</Button>
    {step && <p role="status" className="text-sm text-ink-2">{step}</p>}
    {preview && <pre className="whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs text-ink-2">{preview}</pre>}
    {error && <p role="alert" className="text-sm text-critical">{error}</p>}
  </div>;
}
