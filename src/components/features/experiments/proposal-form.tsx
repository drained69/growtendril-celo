"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { reviseExperimentProposalAction } from "@/server/actions/growth";
import { GOAL_EVENTS, EVENT_LABEL } from "@/server/domain/growth/attribution-links";
import { microToDecimal } from "@/lib/money";
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

/** An editable review step. Saving changes the draft only; money still requires a separate launch and approval. */
export function ProposalForm({ proposal: x }: { proposal: ProposalFields }) {
  const [state, action, pending] = useActionState(reviseExperimentProposalAction.bind(null, x.id), null);
  const router = useRouter();
  useEffect(() => {
    if (!state) return;
    if (state.ok) { toast.success(state.message ?? "Proposal saved"); router.refresh(); }
    else toast.error("Couldn’t save the proposal", state.error);
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepValues(action)} className="space-y-4">
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Experiment title" htmlFor="proposal-title">
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
          <Field label="Maximum budget · USDC" htmlFor="proposal-budget" hint="A ceiling for this experiment, not an immediate charge.">
            <Input id="proposal-budget" name="budget" type="number" min="5" step="0.000001" inputMode="decimal" defaultValue={microToDecimal(x.budgetMicro)} required />
          </Field>
          <Field label="Timeframe · days" htmlFor="proposal-days">
            <Input id="proposal-days" name="timeframeDays" type="number" min={1} max={90} step={1} defaultValue={x.timeframeDays} required />
          </Field>
          <Field label="Success means" htmlFor="proposal-event">
            <Select id="proposal-event" name="successEvent" defaultValue={x.successEvent} required>
              {GOAL_EVENTS.map((event) => <option key={event} value={event}>{EVENT_LABEL[event]}</option>)}
            </Select>
          </Field>
          <Field label="Target count" htmlFor="proposal-count">
            <Input id="proposal-count" name="successTarget" type="number" min={1} max={100000} step={1} defaultValue={x.successTarget} required />
          </Field>
          <Field label="Pause spending after · USDC" htmlFor="proposal-stop-spend" hint="The stop rule is checked once this much confirmed spend is reached.">
            <Input id="proposal-stop-spend" name="stopAfterSpend" type="number" min="0.000001" step="0.000001" inputMode="decimal" defaultValue={microToDecimal(x.stopAfterSpendMicro)} required />
          </Field>
          <Field label="If cost per outcome exceeds · USDC" htmlFor="proposal-stop-cpa">
            <Input id="proposal-stop-cpa" name="stopMaxCpa" type="number" min="0.000001" step="0.000001" inputMode="decimal" defaultValue={microToDecimal(x.stopMaxCpaMicro)} required />
          </Field>
        </div>
        {state && !state.ok && <p role="alert" className="text-[12px] text-critical">{state.error}</p>}
        <Button type="submit" icon={<Save />} loading={pending}>Save proposal</Button>
      </fieldset>
    </form>
  );
}
