"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpFromLine, Fingerprint, KeyRound, ShieldOff } from "lucide-react";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { useHydrated } from "@/components/ui/submit";
import { activateAltanaSessionAction, confirmAltanaRevokeAction, prepareAltanaSessionAction, recordPasskeyWithdrawalAction, saveAltanaWalletAction } from "@/server/actions/celo-rails";
import { altana, ownerFor } from "@/lib/altana-owner";

export interface AltanaSessionView { id: string; publicKey: string; capUsd: string; period: string; expiresAt: string; grantTxHash: string | null; revokeTxHash: string | null }
const TOKENS = [["cNGN", "Naira"], ["IDRX", "Rupiah"], ["wBRL", "Real"], ["wARS", "Argentine peso"], ["wMXN", "Mexican peso"], ["wCOP", "Colombian peso"]] as const;

/** Where the owner can take money out of the passkey wallet, and what's needed to do it. */
export interface AltanaTakeOut { canWithdraw: boolean; balanceMicro: number | null; usdc: string; attributionCode: string | null }

export function AltanaWallet({ address, session, canManage, workspaceName, takeOut }: { address: string | null; session: AltanaSessionView | null; canManage: boolean; workspaceName: string; takeOut?: AltanaTakeOut }) {
  const [capUsd, setCapUsd] = useState("25");
  const [period, setPeriod] = useState<"day" | "week" | "month">("week");
  const [days, setDays] = useState("7");
  const [tokens, setTokens] = useState<string[]>(["cNGN"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const hydrated = useHydrated();
  const locked = !hydrated || !canManage || pending;
  const expired = !!session && Date.parse(session.expiresAt) <= Date.now();

  const run = (task: () => Promise<string>) => {
    setError(null);
    start(async () => {
      try {
        toast.success(await task());
        router.refresh();
      } catch (e) {
        const message = e instanceof Error ? e.message.slice(0, 220) : "Your wallet didn't finish that. Try again.";
        setError(message);
        toast.error("That didn't go through", message);
      }
    });
  };
  const unwrap = <T,>(r: { ok: true; data?: T; message?: string } | { ok: false; error: string }) => {
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  const create = () => run(async () => {
    const { client } = await altana();
    const wallet = await client.createPasskeyWallet({ name: `GrowTendril ${workspaceName}`.slice(0, 48) });
    unwrap(await saveAltanaWalletAction(wallet.address));
    return "Passkey wallet created. Only your passkey can open it.";
  });

  const grant = () => run(async () => {
    const prepared = unwrap(await prepareAltanaSessionAction({ capUsd, period, days: Number(days), tokens })).data;
    if (!prepared) throw new Error("We couldn't prepare GrowTendril's key. Try again.");
    const { sdk, client, owner } = await ownerFor(address!);
    // The private half of this key stays on the server and never reaches the browser.
    const agentKey = { type: "privateKey" as const, address: prepared.sessionAddress as Address, publicKey: prepared.publicKey as Hex, signDigest: async (): Promise<Hex> => { throw new Error("The browser cannot sign as the agent"); } };
    const result = await client.grantSession({
      wallet: { address: address as Address }, signer: owner.signer, sessionSigner: agentKey, expiry: prepared.expiry, feeToken: sdk.NATIVE_TOKEN,
      permissions: { calls: prepared.permissions.calls, spend: prepared.permissions.spend.map((p) => ({ ...p, limit: BigInt(p.limit) })) },
    });
    unwrap(await activateAltanaSessionAction(prepared.id, result.transactionHash ?? null));
    return prepared.skipped.length ? `GrowTendril's key is active. ${prepared.skipped.join(", ")} had no live price, so they were left out.` : "GrowTendril's key is active, with your limits";
  });

  const revoke = () => run(async () => {
    if (!session) throw new Error("GrowTendril has no key to take back.");
    const { client, owner } = await ownerFor(address!);
    const result = await client.revokeSession({ wallet: { address: address as Address }, signer: owner.signer, session: session.publicKey as Hex });
    unwrap(await confirmAltanaRevokeAction(session.id, result.transactionHash ?? null));
    return "Key taken back. GrowTendril can no longer pay from this wallet.";
  });

  if (!address) return <div className="space-y-3">
    <p className="text-sm text-ink-3">Keep the money in a wallet you open with your fingerprint or face (made by Altana). GrowTendril gets a key that can only spend up to a cap you set, until a date you choose, and you can take it back at any time.</p>
    <Button variant="primary" icon={<Fingerprint />} loading={pending} disabled={locked} onClick={create}>Create passkey wallet</Button>
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
  </div>;

  if (session && !expired) return <div className="space-y-3">
    <dl className="grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-[11.5px] text-ink-3">GrowTendril can spend up to</dt><dd className="num font-medium">{session.capUsd} per {session.period}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Only for</dt><dd className="font-medium">Paying people in digital dollars or local currency</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">Key works until</dt><dd className="font-medium">{new Date(session.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</dd></div>
    </dl>
    {session.grantTxHash && <a className="text-[12px] underline" href={`https://celoscan.io/tx/${session.grantTxHash}`} target="_blank" rel="noreferrer">See proof on Celoscan</a>}
    <div><Button variant="danger" icon={<ShieldOff />} loading={pending} disabled={locked} onClick={revoke}>Take back GrowTendril&apos;s key</Button></div>
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
    {takeOut && <TakeOut address={address} {...takeOut} />}
  </div>;

  return <div className="space-y-4">
    <p className="text-sm text-ink-3">Add USDC to this wallet, plus a few cents of CELO for network fees (and USD₮ only if you pay creators in local currency). Then choose what GrowTendril may spend.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="GrowTendril may spend up to ($)" htmlFor="altana-cap"><Input id="altana-cap" inputMode="decimal" value={capUsd} onChange={(e) => setCapUsd(e.target.value)} disabled={locked} className="num" /></Field>
      <Field label="That amount resets every" htmlFor="altana-period"><Select id="altana-period" value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} disabled={locked}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></Select></Field>
      <Field label="Key lasts (days)" htmlFor="altana-days"><Input id="altana-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={locked} className="num" /></Field>
    </div>
    <fieldset><legend className="mb-2 text-[12px] font-medium text-ink-2">Pay creators in their local currency (optional)</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{TOKENS.map(([token, label]) => <Checkbox key={token} label={`${token} · ${label}`} checked={tokens.includes(token)} disabled={locked} onChange={(e) => setTokens((all) => e.target.checked ? [...all, token] : all.filter((t) => t !== token))} />)}</div>
    </fieldset>
    <Button variant="primary" icon={<KeyRound />} loading={pending} disabled={locked} onClick={grant}>Give GrowTendril a limited key</Button>
    {expired && <p className="text-[12px] text-ink-3">GrowTendril&apos;s last key has expired and can no longer spend. Give it a new one to keep paying people.</p>}
    {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
    {takeOut && <TakeOut address={address} {...takeOut} />}
  </div>;
}

/** The owner sends USDC out of their passkey wallet. Only their passkey can sign it. */
function TakeOut({ address, canWithdraw, balanceMicro, usdc, attributionCode }: { address: string } & AltanaTakeOut) {
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const hydrated = useHydrated();
  const validAmount = /^\d{1,7}(\.\d{1,6})?$/.test(amount.trim()) && Number(amount) > 0;
  const micro = validAmount ? Number(parseUnits(amount.trim(), 6)) : 0;
  const over = balanceMicro != null && micro > balanceMicro;
  const target = to.trim();
  const validTo = isAddress(target) && target.toLowerCase() !== address.toLowerCase();
  const locked = !hydrated || !canWithdraw || busy;

  const send = () => start(async () => {
    setError(null);
    if (!window.confirm(`Send ${amount.trim()} USDC from this passkey wallet to ${target}?\n\nCheck the address carefully: money sent to the wrong address can't be brought back.`)) return;
    let submitted = false;
    try {
      const { sdk, client, owner } = await ownerFor(address);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(target), parseUnits(amount.trim(), 6)] });
      const tag = attributionCode ? toDataSuffix(attributionCode).slice(2) : "";
      submitted = true;
      // The network fee is paid in CELO if the wallet holds some, otherwise in USDC.
      const result = await client.execute({ wallet: { address: address as Address }, signer: owner.signer, calls: [{ to: usdc as Address, data: `${data}${tag}` as Hex }], feeToken: [sdk.NATIVE_TOKEN, usdc as Address] });
      if (result.status === "FAILED") throw new Error("Altana reported that the transfer failed. No USDC moved.");
      if (!result.transactionHash) {
        toast.info("Sent", "Celo hasn't confirmed it yet. Check the balance here in a minute before trying again.");
        router.refresh();
        return;
      }
      const r = await recordPasskeyWithdrawalAction(result.transactionHash);
      if (!r.ok) throw new Error(r.error);
      toast.success(r.message ?? "Sent");
      setAmount("");
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cancelled = (e as { name?: string }).name === "NotAllowedError" || /reject|denied|cancel|not allowed/i.test(msg);
      if (cancelled) return;
      const text = submitted && !/failed/i.test(msg) ? `We couldn't confirm the transfer: ${msg.slice(0, 160)}. Check the balance before trying again.` : msg.slice(0, 220);
      setError(text);
      toast.error("Money wasn't taken out", text);
    }
  });

  return <div className="space-y-3 border-t border-line pt-4">
    <div>
      <div className="text-[13px] font-medium text-ink">Take money out</div>
      <p className="mt-0.5 text-[12px] text-ink-3">Send USDC from this wallet to another wallet you own, such as MetaMask or MiniPay. You confirm it with your passkey. A tiny network fee is paid in CELO if the wallet has some, otherwise in USDC.</p>
    </div>
    {canWithdraw ? <>
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="Amount · USDC" htmlFor="altana-out-amount" error={over ? "That's more than the wallet holds." : null}>
          <div className="flex gap-2">
            <Input id="altana-out-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.00" className="num" disabled={locked} />
            {balanceMicro != null && balanceMicro > 0 && <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setAmount(formatUnits(BigInt(balanceMicro), 6))}>All</Button>}
          </div>
        </Field>
        <Field label="Send to (a wallet address you own)" htmlFor="altana-out-to" error={target && !isAddress(target) ? "That isn't a valid wallet address." : target && target.toLowerCase() === address.toLowerCase() ? "That's this wallet's own address." : null}>
          <Input id="altana-out-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" className="num" disabled={locked} />
        </Field>
      </div>
      <Button icon={<ArrowUpFromLine />} loading={busy} disabled={locked || !validAmount || over || !validTo} onClick={send}>Take money out</Button>
      {balanceMicro != null && micro > 0 && micro === balanceMicro && <p className="text-[11.5px] text-ink-3">Taking everything out works only if the wallet has a little CELO for the fee. If it fails, leave a few cents of USDC behind.</p>}
      {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
    </> : <p className="text-[12px] text-ink-3">Only the workspace owner can take money out.</p>}
  </div>;
}
