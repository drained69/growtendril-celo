"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { reviseExperimentProposalAction } from "@/server/actions/growth";
import { GOAL_EVENTS, EVENT_LABEL } from "@/server/domain/growth/attribution-links";
import { fmtUsdc, microToDecimal, toMicro } from "@/lib/money";
import { paymentPlan } from "@/lib/budget";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { keepValues } from "@/components/ui/submit";

export interface ProposalFields {
  id: string;
  title: string;
  hypothesis: string;
  target: string;
  action: string;
  budgetMicro: number;
  successEvent: string;
  successTarget: number;
  stopMaxCpaMicro: number;
  stopAfterSpendMicro: number;
  timeframeDays: number;
}

/** An editable review step. Saving changes the draft only; money still needs a separate launch and your OK. */
export function ProposalForm({ proposal: x, largestPaymentMicro }: { proposal: ProposalFields; largestPaymentMicro: number }) {
  const [state, action, pending] = useActionState(reviseExperimentProposalAction.bind(null, x.id), null);
  const [budget, setBudget] = useState(microToDecimal(x.budgetMicro));
  const budgetMicro = /^\d+(\.\d{1,6})?$/.test(budget) ? toMicro(budget) : 0;
  const plan = paymentPlan(budgetMicro, largestPaymentMicro);
  const [payment, setPayment] = useState<"one" | "split">(x.stopAfterSpendMicro >= x.budgetMicro ? "one" : "split");
  // One payment only fits up to the largest single payment.
  const mode = plan.payments === 2 ? "split" : payment;
  const router = useRouter();
  useEffect(() => {
    if (!state) return;
    if (state.ok) { toast.success(state.message ?? "Test saved"); router.refresh(); }
    else toast.error("Couldn’t save the test", state.error);
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepValues(action)} className="space-y-4">
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Test name" htmlFor="proposal-title">
          <Input id="proposal-title" name="title" defaultValue={x.title} minLength={4} maxLength={160} required />
        </Field>
        <Field label="What do you expect to happen?" htmlFor="proposal-hypothesis">
          <Textarea id="proposal-hypothesis" name="hypothesis" defaultValue={x.hypothesis} minLength={15} maxLength={1200} rows={3} required />
        </Field>
        <Field label="Who or what should this reach?" htmlFor="proposal-target">
          <Input id="proposal-target" name="target" defaultValue={x.target} minLength={3} maxLength={300} required />
        </Field>
        <Field label="The work to do" htmlFor="proposal-action" hint="Be specific enough that you can later check whether it was delivered.">
          <Textarea id="proposal-action" name="action" defaultValue={x.action} minLength={15} maxLength={1200} rows={3} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Budget · USDC" htmlFor="proposal-budget" hint="The most this test can pay. It comes out of this month's budget.">
            <Input id="proposal-budget" name="budget" type="number" min="5" step="0.000001" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} required />
          </Field>
          <Field label="How long · days" htmlFor="proposal-days">
            <Input id="proposal-days" name="timeframeDays" type="number" min={1} max={90} step={1} defaultValue={x.timeframeDays} required />
          </Field>
          <Field label="Success means" htmlFor="proposal-event">
            <Select id="proposal-event" name="successEvent" defaultValue={x.successEvent} required>
              {GOAL_EVENTS.map((event) => <option key={event} value={event}>{EVENT_LABEL[event]}</option>)}
            </Select>
          </Field>
          <Field label="How many" htmlFor="proposal-count">
            <Input id="proposal-count" name="successTarget" type="number" min={1} max={100000} step={1} defaultValue={x.successTarget} required />
          </Field>
          <Field label="How it's paid" htmlFor="proposal-payment" hint={plan.payments === 2 ? `Above your largest single payment (${fmtUsdc(largestPaymentMicro)}), so it's split in two.` : "Pay it all at launch, or keep half until the work is live."}>
            <Select id="proposal-payment" name="payment" value={mode} onChange={(e) => setPayment(e.target.value as "one" | "split")}>
              <option value="one" disabled={plan.payments === 2}>In one payment</option>
              <option value="split">Pay half now, half when the work is live</option>
            </Select>
          </Field>
          <input type="hidden" name="stopAfterSpend" value={microToDecimal(Math.max(1, mode === "one" ? budgetMicro : budgetMicro - Math.floor(budgetMicro / 2)))} />
        </div>
        {!plan.fits && budgetMicro > 0 && <p role="status" className="rounded-[8px] border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[12px] text-ink-2">Even split in two, each payment would be {fmtUsdc(plan.neededLargestMicro)}, more than your largest single payment of {fmtUsdc(largestPaymentMicro)}. Lower the budget, or raise the largest single payment in Settings → Budget.</p>}
        <details className="rounded-[8px] border border-line">
          <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-ink-2">Advanced: stop rule</summary>
          <div className="border-t border-line p-3">
            <Field label="Stop if each result costs more than · USDC" htmlFor="proposal-stop-cpa" hint="Checked after the first payment, before the second half is paid.">
              <Input id="proposal-stop-cpa" name="stopMaxCpa" type="number" min="0.000001" step="0.000001" inputMode="decimal" defaultValue={microToDecimal(x.stopMaxCpaMicro)} required />
            </Field>
          </div>
        </details>
        {state && !state.ok && <p role="alert" className="text-[12px] text-critical">{state.error}</p>}
        <Button type="submit" icon={<Save />} loading={pending}>Save test</Button>
      </fieldset>
    </form>
  );
}
