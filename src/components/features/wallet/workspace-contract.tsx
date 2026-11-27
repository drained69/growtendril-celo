"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { erc20Abi, formatUnits, parseUnits, type Abi, type Address } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, Bot, BotOff, Check, FileCheck2, Landmark, Rocket, ShieldOff, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { CopyField } from "@/components/ui/copy";
import { toast } from "@/components/ui/toast";
import { useHydrated } from "@/components/ui/submit";
import { GROWTH_FACTORY_ABI, GROWTH_WORKSPACE_ABI } from "@/lib/celo-protocol-abi";
import { celoReader, connectCelo, sendCelo, walletError } from "@/lib/celo-browser";
import { linkWorkspaceAction, syncProtocolAction } from "@/server/actions/protocol";
import type { ProtocolView } from "@/server/integrations/celo/protocol";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;
const TOKENS = { USDC, "USD₮": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address };
type TokenName = keyof typeof TOKENS;
const ROLE_OPERATOR = 4;
const workspaceAbi = GROWTH_WORKSPACE_ABI as Abi;
const policyArgs = (p: ProtocolView["policy"]) => ({ autonomyEnabled: p.autonomyEnabled, maxTransaction: BigInt(p.maxTransaction), dailySpend: BigInt(p.dailySpend), hardCeiling: BigInt(p.hardCeiling), autonomousCategories: p.autonomousCategories, approvalCategories: p.approvalCategories });
const free = (f: ProtocolView["funds"][number]) => { const n = BigInt(f.balance) - BigInt(f.reserved); return n > 0n ? n : 0n; };
const show = (micro: bigint | string) => Number(formatUnits(BigInt(micro), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * The recommended Payout account: a contract on Celo that only the owner's wallet controls.
 * Everything here is signed by the owner's own wallet.
 */
export function WorkspaceContract({ view, canManage }: { view: ProtocolView; canManage: boolean }) {
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<TokenName>("USDC");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const hydrated = useHydrated();
  const locked = !hydrated || !canManage || pending;
  const validAmount = /^\d{1,9}(\.\d{1,6})?$/.test(amount.trim()) && Number(amount) > 0;

  const run = (task: () => Promise<string>) => {
    setError(null);
    start(async () => {
      try {
        toast.success(await task());
        router.refresh();
      } catch (e) {
        const message = walletError(e);
        setError(message);
        toast.error("That didn't go through", message);
      }
    });
  };
  const send = (functionName: string, args: readonly unknown[]) => sendCelo({ address: view.workspace!, abi: workspaceAbi, functionName, args, attribution: view.attribution });
  const linked = async (message: string) => {
    const r = await syncProtocolAction();
    if (!r.ok) throw new Error(r.error);
    return message;
  };

  const create = () => run(async () => {
    if (!view.operator) throw new Error("This server isn't set up to create Payout accounts yet. Ask the GrowTendril operator.");
    const { account } = await connectCelo();
    const predicted = await celoReader.readContract({ address: view.factory, abi: GROWTH_FACTORY_ABI, functionName: "addressOf", args: [account, view.ref] });
    const exists = await celoReader.readContract({ address: view.factory, abi: GROWTH_FACTORY_ABI, functionName: "isWorkspace", args: [predicted] });
    if (!exists) await sendCelo({ address: view.factory, abi: GROWTH_FACTORY_ABI as Abi, functionName: "createWorkspace", args: [view.ref, view.operator, policyArgs(view.policy)], attribution: view.attribution });
    const saved = await linkWorkspaceAction(predicted);
    if (!saved.ok) throw new Error(saved.error);
    return exists ? "Your Payout account is connected" : "Your Payout account is ready";
  });
  const deposit = () => run(async () => {
    await sendCelo({ address: TOKENS[token], abi: erc20Abi as Abi, functionName: "transfer", args: [view.workspace!, parseUnits(amount.trim(), 6)], attribution: view.attribution });
    setAmount("");
    return `${token} added to your Payout account`;
  });
  const withdraw = () => run(async () => {
    const { account } = await connectCelo();
    await send("withdraw", [TOKENS[token], account, parseUnits(amount.trim(), 6)]);
    setAmount("");
    return `${token} sent back to your wallet`;
  });
  const setAgent = (active: boolean) => run(async () => {
    await send("setRole", [view.operator!, active ? ROLE_OPERATOR : 0]);
    return linked(active ? "GrowTendril can suggest payments again" : "GrowTendril can no longer suggest payments from this account");
  });
  const publishPolicy = () => run(async () => { await send("setPolicy", [policyArgs(view.policy)]); return "Your limits are confirmed"; });
  const publishMission = () => run(async () => {
    const m = view.mission!;
    await send("openMission", [m.id, BigInt(m.budget), BigInt(m.endsAt), m.goalHash, m.categories, m.budgets.map(BigInt)]);
    return "This month's budget is confirmed";
  });
  const updateBudget = () => run(async () => {
    const m = view.mission!;
    await send("updateMission", [m.id, BigInt(m.budget), BigInt(m.endsAt), true]);
    return "Your new budget is confirmed";
  });
  const setFrozen = (value: boolean) => run(async () => { await send("setFrozen", [value]); return linked(value ? "All payments are paused" : "Payments are back on"); });

  if (!view.workspace) return <div className="space-y-3">
    <p className="text-sm text-ink-2"><span className="font-medium text-ink">Recommended.</span> Your Payout account is a small account on Celo that only your own wallet controls. You add money, your limits are built in, and you approve every payment to a person. GrowTendril can only suggest payments inside your limits.</p>
    <ol className="space-y-1 text-[12.5px] text-ink-3">
      <li><span className="num mr-1.5 text-ink-2">1.</span>Create it (your wallet signs once; the network fee is under a cent)</li>
      <li><span className="num mr-1.5 text-ink-2">2.</span>Add money</li>
      <li><span className="num mr-1.5 text-ink-2">3.</span>Done — we ask you before paying anyone</li>
    </ol>
    <Button variant="primary" icon={<Rocket />} loading={pending} disabled={locked || !view.operator} onClick={create}>Create my Payout account</Button>
    {!view.operator && <p className="text-[12px] text-ink-3">Not available yet: this server isn&apos;t set up to create Payout accounts. Ask the GrowTendril operator to finish setup.</p>}
    {!canManage && <p className="text-[12px] text-ink-3">Only the workspace owner or an admin can set this up.</p>}
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
  </div>;

  const funded = view.funds.some((f) => BigInt(f.balance) > 0n);
  const m = view.mission;
  type Step = { done: boolean; title: string; hint: string; action: React.ReactNode };
  const steps: Step[] = [
    { done: true, title: "Create your Payout account", hint: "", action: null },
    { done: funded, title: "Add money", hint: "Add USDC from your wallet with “Add money” below. You only need USD₮ to pay creators in their local currency.", action: null },
    m
      ? m.published
        ? { done: m.budgetInSync, title: "Your budget changed — confirm it in your wallet", hint: `So your Payout account enforces your new monthly budget of ${show(m.budget)} USDC.`, action: <Button variant="primary" icon={<Landmark />} disabled={locked} onClick={updateBudget}>Confirm new budget</Button> }
        : { done: false, title: "Confirm this month's budget", hint: `Your wallet confirms the ${show(m.budget)} USDC monthly budget, so the account enforces it.`, action: <Button variant="primary" icon={<Landmark />} disabled={locked} onClick={publishMission}>Confirm budget</Button> }
      : { done: false, title: "Set a goal and monthly budget", hint: "Tests are paid out of your monthly budget.", action: <Link className="text-[12.5px] underline" href="/onboarding?step=3">Set a goal</Link> },
  ];
  if (!view.policyInSync) steps.push({ done: false, title: "Your limits changed — confirm them in your wallet", hint: "So your Payout account enforces your largest single payment and daily limit from Settings.", action: <Button variant="primary" icon={<FileCheck2 />} disabled={locked} onClick={publishPolicy}>Confirm limits</Button> });
  const next = steps.findIndex((s) => !s.done);
  const selected = view.funds.find((f) => f.token === token);

  return <div className="space-y-4">
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-[11.5px] text-ink-3">Payments</dt><dd className="font-medium">{view.frozen ? "Paused" : "On"}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">GrowTendril can suggest payments</dt><dd className="font-medium">{view.operatorActive ? "Yes" : "No"}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Your limits</dt><dd className="font-medium">{view.policyInSync && (!m || m.budgetInSync) ? "Confirmed" : "Need confirming"}</dd></div>
    </dl>
    {next !== -1 ? <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-[12.5px] font-medium">Next steps</p>
      <ol className="space-y-2">
        {steps.map((s, i) => <li key={s.title} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className={s.done ? "text-good" : "text-ink-3"} aria-hidden>{s.done ? <Check className="size-4" /> : `${i + 1}.`}</span>
          <span className={s.done ? "text-ink-3 line-through" : "font-medium"}>{s.title}</span>
          {!s.done && s.hint && <span className="basis-full pl-7 text-[12px] text-ink-3">{s.hint}</span>}
          {!s.done && i === next && s.action && <span className="basis-full pl-7">{s.action}</span>}
          <span className="sr-only">{s.done ? "done" : "to do"}</span>
        </li>)}
      </ol>
    </div> : <p className="flex items-center gap-2 rounded-lg border border-good/30 bg-good/[0.05] px-3 py-2 text-[12.5px] text-ink-2"><Check className="size-4 text-good" /> All set. We&apos;ll ask you before paying anyone.</p>}
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11.5px] text-ink-3"><th className="py-1 pr-3 font-normal">Money</th><th className="py-1 pr-3 font-normal">In your account</th><th className="py-1 pr-3 font-normal">Set aside for approved payments</th><th className="py-1 font-normal">Free to take out</th></tr></thead>
        <tbody>{view.funds.map((f) => <tr key={f.token} className="border-t border-line"><td className="py-1.5 pr-3">{f.token}</td><td className="num py-1.5 pr-3">{show(f.balance)}</td><td className="num py-1.5 pr-3">{show(f.reserved)}</td><td className="num py-1.5">{show(free(f))}</td></tr>)}</tbody>
      </table>
    </div>
    <Field label="Add or take out money" htmlFor="workspace-amount" hint="Money comes from the wallet you connect. Only you can take it out; money set aside for an approved payment stays until it is paid.">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Which money" value={token} onChange={(e) => setToken(e.target.value as TokenName)} className="w-28" disabled={locked}>{Object.keys(TOKENS).map((name) => <option key={name}>{name}</option>)}</Select>
        <Input id="workspace-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" className="num max-w-40" disabled={locked} />
        <Button icon={<ArrowDownToLine />} disabled={locked || !validAmount} onClick={deposit}>Add money</Button>
        <Button variant="ghost" icon={<ArrowUpFromLine />} disabled={locked || !validAmount} onClick={withdraw}>Take out</Button>
        {selected && free(selected) > 0n && <Button variant="ghost" disabled={locked} onClick={() => setAmount(formatUnits(free(selected), 6))}>All of it</Button>}
      </div>
    </Field>
    <div className="flex flex-wrap gap-2">
      {view.frozen ? <Button icon={<Unlock />} disabled={locked} onClick={() => setFrozen(false)}>Turn payments back on</Button> : <Button variant="danger" icon={<ShieldOff />} disabled={locked} onClick={() => setFrozen(true)}>Pause all payments</Button>}
      {view.operator && (view.operatorActive ? <Button variant="ghost" icon={<BotOff />} disabled={locked} onClick={() => setAgent(false)}>Remove GrowTendril&apos;s access</Button> : <Button icon={<Bot />} disabled={locked} onClick={() => setAgent(true)}>Give GrowTendril access again</Button>)}
    </div>
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
    <details className="text-[12px] text-ink-3">
      <summary className="cursor-pointer">Proof / technical details</summary>
      <div className="mt-2 space-y-2">
        <p>Your Payout account is a contract on the Celo network. Its address:</p>
        <CopyField value={view.workspace} />
        <p>Records saved on Celo: <span className="num">{view.checkpoints}</span>. <a className="underline" href={`https://celoscan.io/address/${view.workspace}`} target="_blank" rel="noreferrer">See it on Celoscan</a></p>
      </div>
    </details>
  </div>;
}
