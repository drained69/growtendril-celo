"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Save } from "lucide-react";
import { updateBudgetAction } from "@/server/actions/workspace";
import { Button, Checkbox, Field, Input } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { keepValues } from "@/components/ui/submit";
import { defaultLargestPaymentMicro, deriveLimits } from "@/lib/budget";
import { fmtUsdc, microToDecimal, toMicro } from "@/lib/money";

const valid = (v: string) => /^\d+(\.\d{1,6})?$/.test(v.trim());

/** The three things an owner sets about money. The daily limit and per-type budgets follow from them. */
export function BudgetForm({ current, disabled, usage }: { current: { monthlyMicro: number; largestPaymentMicro: number; researchMonthlyMicro: number }; disabled?: boolean; usage?: string }) {
  const [state, action, pending] = useActionState(updateBudgetAction, null);
  const router = useRouter();
  const [monthly, setMonthly] = useState(microToDecimal(current.monthlyMicro));
  const [largest, setLargest] = useState(microToDecimal(current.largestPaymentMicro));
  const [research, setResearch] = useState(current.researchMonthlyMicro > 0);
  const [researchMonthly, setResearchMonthly] = useState(microToDecimal(current.researchMonthlyMicro || Math.min(current.monthlyMicro, 5_000_000)));
  useEffect(() => {
    if (!state) return;
    if (state.ok) { toast.success(state.message ?? "Budget saved"); router.refresh(); }
    else toast.error("Couldn’t save the budget", state.error);
  }, [state, router]);
  const monthlyMicro = valid(monthly) ? toMicro(monthly) : 0;
  const suggested = defaultLargestPaymentMicro(monthlyMicro);
  const limits = deriveLimits({ monthlyMicro, largestPaymentMicro: valid(largest) && Number(largest) > 0 ? toMicro(largest) : undefined, researchMonthlyMicro: research && valid(researchMonthly) ? toMicro(researchMonthly) : 0 });
  return (
    <form action={action} onSubmit={keepValues(action)}>
      <fieldset disabled={disabled || pending} className="space-y-5 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly growth budget · USDC" htmlFor="budget-monthly" hint={usage ?? "The most GrowTendril can spend on tests and research each month. Unspent money doesn't roll over."}>
            <Input id="budget-monthly" name="monthly" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} className="num" required />
          </Field>
          <Field label="Largest single payment · USDC" htmlFor="budget-largest" hint={`No single payment can be bigger, even with your OK. Suggested for this budget: ${fmtUsdc(suggested)} (a quarter of it, at most $50).`}>
            <div className="flex gap-2">
              <Input id="budget-largest" name="largest" inputMode="decimal" value={largest} onChange={(e) => setLargest(e.target.value)} className="num" />
              {monthlyMicro > 0 && toMicro(largest || "0") !== suggested && <Button type="button" variant="ghost" size="sm" onClick={() => setLargest(microToDecimal(suggested))}>Use {fmtUsdc(suggested, { unit: false })}</Button>}
            </div>
          </Field>
        </div>
        <div className="space-y-2.5 rounded-[10px] border border-line p-3">
          <div className="text-[12.5px] font-medium text-ink">What needs your OK</div>
          <p className="flex items-start gap-2 text-[12.5px] text-ink-2"><Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" /><span><span className="font-medium text-ink">Payments to people:</span> GrowTendril always asks you first. This can&apos;t be turned off.</span></p>
          <Checkbox label="Let GrowTendril buy research on its own" name="research" checked={research} onChange={(e) => setResearch(e.target.checked)} />
          {research && (
            <Field label="Up to this much a month · USDC" htmlFor="budget-research" hint="Data and research services only, out of your monthly budget. Anything more asks you first.">
              <Input id="budget-research" name="researchMonthly" inputMode="decimal" value={researchMonthly} onChange={(e) => setResearchMonthly(e.target.value)} className="num max-w-40" />
            </Field>
          )}
        </div>
        <p className="text-[12px] text-ink-3">
          Set automatically: a daily limit of <span className="num text-ink-2">{fmtUsdc(limits.dailySpendMicro)}</span> (three largest payments){research && limits.autonomousLimitMicro > 0 ? <>, and research bought on its own up to <span className="num text-ink-2">{fmtUsdc(limits.autonomousLimitMicro)}</span> at a time</> : null}. The GrowTendril fee for scans comes from your credit, never from this budget.
        </p>
        {state && !state.ok && <p role="alert" className="text-[12px] text-critical">{state.error}</p>}
        <Button type="submit" variant="primary" icon={<Save />} loading={pending}>Save budget</Button>
      </fieldset>
    </form>
  );
}
