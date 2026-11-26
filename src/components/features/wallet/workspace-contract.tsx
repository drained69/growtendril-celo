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

/** Everything here is signed by the workspace owner's own wallet on Celo mainnet. */
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
        toast.error("Action did not complete", message);
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
    if (!view.operator) throw new Error("The GrowTendril operator is not configured yet");
    const { account } = await connectCelo();
    const predicted = await celoReader.readContract({ address: view.factory, abi: GROWTH_FACTORY_ABI, functionName: "addressOf", args: [account, view.ref] });
    const exists = await celoReader.readContract({ address: view.factory, abi: GROWTH_FACTORY_ABI, functionName: "isWorkspace", args: [predicted] });
    if (!exists) await sendCelo({ address: view.factory, abi: GROWTH_FACTORY_ABI as Abi, functionName: "createWorkspace", args: [view.ref, view.operator, policyArgs(view.policy)], attribution: view.attribution });
    const saved = await linkWorkspaceAction(predicted);
    if (!saved.ok) throw new Error(saved.error);
    return exists ? "Workspace contract linked" : "Workspace contract created on Celo";
  });
  const deposit = () => run(async () => {
    await sendCelo({ address: TOKENS[token], abi: erc20Abi as Abi, functionName: "transfer", args: [view.workspace!, parseUnits(amount.trim(), 6)], attribution: view.attribution });
    setAmount("");
    return `${token} deposited`;
  });
  const withdraw = () => run(async () => {
    const { account } = await connectCelo();
    await send("withdraw", [TOKENS[token], account, parseUnits(amount.trim(), 6)]);
    setAmount("");
    return `${token} returned to your wallet`;
  });
  const setAgent = (active: boolean) => run(async () => {
    await send("setRole", [view.operator!, active ? ROLE_OPERATOR : 0]);
    return linked(active ? "GrowTendril agent restored" : "GrowTendril agent removed from this contract");
  });
  const publishPolicy = () => run(async () => { await send("setPolicy", [policyArgs(view.policy)]); return "Spending rules published"; });
  const publishMission = () => run(async () => {
    const m = view.mission!;
    await send("openMission", [m.id, BigInt(m.budget), BigInt(m.endsAt), m.goalHash, m.categories, m.budgets.map(BigInt)]);
    return "Mission published";
  });
  const setFrozen = (value: boolean) => run(async () => { await send("setFrozen", [value]); return linked(value ? "Spending frozen onchain" : "Spending resumed"); });

  if (!view.workspace) return <div className="space-y-3">
    <p className="text-sm text-ink-3">Create your workspace contract. Your wallet owns it, your budget and rules live on Celo, and GrowTendril’s agent can only act inside them.</p>
    <p className="text-[12px] text-ink-3">Your wallet signs one transaction on Celo mainnet and pays a small CELO network fee.</p>
    <Button variant="primary" icon={<Rocket />} loading={pending} disabled={locked || !view.operator} onClick={create}>Create workspace contract</Button>
    {!view.operator && <p className="text-[12px] text-ink-3">Available once GrowTendril’s agent is set up on this server.</p>}
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
  </div>;

  const funded = view.funds.some((f) => BigInt(f.balance) > 0n);
  const steps = [
    { done: view.policyInSync, title: "Publish your spending rules", hint: "Your per-payment ceiling and daily limit from Settings, enforced by the contract.", action: <Button variant="primary" icon={<FileCheck2 />} disabled={locked} onClick={publishPolicy}>Publish rules</Button> },
    view.mission
      ? { done: view.mission.published, title: `Publish your mission “${view.mission.name}”`, hint: `Sets the ${show(view.mission.budget)} USDC budget the agent plans payments against.`, action: <Button variant="primary" icon={<Landmark />} disabled={locked} onClick={publishMission}>Publish mission</Button> }
      : { done: false, title: "Start a mission", hint: "A mission sets the goal and budget the agent works toward.", action: <Link className="text-[12.5px] underline" href="/app/missions">Go to Missions</Link> },
    { done: funded, title: "Deposit funds", hint: "USDC pays creators and services. USD₮ pays creators in their local currency. Use Move funds below.", action: null },
  ];
  const next = steps.findIndex((s) => !s.done);
  const selected = view.funds.find((f) => f.token === token);

  return <div className="space-y-4">
    <CopyField value={view.workspace} />
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <div><dt className="text-[11.5px] text-ink-3">Status</dt><dd className="font-medium">{view.frozen ? "Frozen" : "Active"}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Agent access</dt><dd className="font-medium">{view.operatorActive ? "Allowed" : "Removed"}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Spending rules</dt><dd className="font-medium">{view.policyInSync ? "Published" : "Update needed"}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Ledger checkpoints</dt><dd className="num font-medium">{view.checkpoints}</dd></div>
    </dl>
    {next !== -1 && <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-[12.5px] font-medium">Next steps</p>
      <ol className="space-y-2">
        {steps.map((s, i) => <li key={s.title} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className={s.done ? "text-good" : "text-ink-3"} aria-hidden>{s.done ? <Check className="size-4" /> : `${i + 1}.`}</span>
          <span className={s.done ? "text-ink-3 line-through" : "font-medium"}>{s.title}</span>
          {!s.done && <span className="basis-full pl-7 text-[12px] text-ink-3">{s.hint}</span>}
          {!s.done && i === next && s.action && <span className="basis-full pl-7">{s.action}</span>}
          <span className="sr-only">{s.done ? "done" : "to do"}</span>
        </li>)}
      </ol>
    </div>}
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11.5px] text-ink-3"><th className="py-1 pr-3 font-normal">Token</th><th className="py-1 pr-3 font-normal">In contract</th><th className="py-1 pr-3 font-normal">Reserved for open payments</th><th className="py-1 font-normal">Free to withdraw</th></tr></thead>
        <tbody>{view.funds.map((f) => <tr key={f.token} className="border-t border-line"><td className="py-1.5 pr-3">{f.token}</td><td className="num py-1.5 pr-3">{show(f.balance)}</td><td className="num py-1.5 pr-3">{show(f.reserved)}</td><td className="num py-1.5">{show(free(f))}</td></tr>)}</tbody>
      </table>
    </div>
    <a className="inline-block text-[12px] underline" href={`https://celoscan.io/address/${view.workspace}`} target="_blank" rel="noreferrer">View contract on Celoscan</a>
    <div className="flex flex-wrap gap-2">
      {view.frozen ? <Button icon={<Unlock />} disabled={locked} onClick={() => setFrozen(false)}>Resume spending</Button> : <Button variant="danger" icon={<ShieldOff />} disabled={locked} onClick={() => setFrozen(true)}>Freeze onchain</Button>}
      {view.operator && (view.operatorActive ? <Button variant="ghost" icon={<BotOff />} disabled={locked} onClick={() => setAgent(false)}>Remove agent</Button> : <Button icon={<Bot />} disabled={locked} onClick={() => setAgent(true)}>Restore agent</Button>)}
    </div>
    <Field label="Move funds" htmlFor="workspace-amount" hint="Deposits come from your connected wallet. Only you can withdraw, and funds reserved for an open payment stay in the contract.">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Token" value={token} onChange={(e) => setToken(e.target.value as TokenName)} className="w-28" disabled={locked}>{Object.keys(TOKENS).map((name) => <option key={name}>{name}</option>)}</Select>
        <Input id="workspace-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" className="num max-w-40" disabled={locked} />
        <Button icon={<ArrowDownToLine />} disabled={locked || !validAmount} onClick={deposit}>Deposit</Button>
        <Button variant="ghost" icon={<ArrowUpFromLine />} disabled={locked || !validAmount} onClick={withdraw}>Withdraw</Button>
        {selected && free(selected) > 0n && <Button variant="ghost" disabled={locked} onClick={() => setAmount(formatUnits(free(selected), 6))}>Max</Button>}
      </div>
    </Field>
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
  </div>;
}
