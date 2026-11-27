"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, KeyRound, ShieldOff } from "lucide-react";
import type { Address, Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { useHydrated } from "@/components/ui/submit";
import { activateAltanaSessionAction, confirmAltanaRevokeAction, prepareAltanaSessionAction, saveAltanaWalletAction } from "@/server/actions/celo-rails";
import { celoReader } from "@/lib/celo-browser";
import { recoverPasskeyForWallet } from "@/lib/passkey-recovery";

export interface AltanaSessionView { id: string; publicKey: string; capUsd: string; period: string; expiresAt: string; grantTxHash: string | null; revokeTxHash: string | null }
const TOKENS = [["cNGN", "Naira"], ["IDRX", "Rupiah"], ["wBRL", "Real"], ["wARS", "Argentine peso"], ["wMXN", "Mexican peso"], ["wCOP", "Colombian peso"]] as const;

async function altana() {
  const sdk = await import("@altananetwork/sdk");
  return { sdk, client: sdk.createClient({ chains: [sdk.CELO], agentIdentity: { name: "GrowTendril Growth Operator", description: "Pays creators under limits its owner sets onchain.", endpoint: window.location.origin } }) };
}
/**
 * The owner's passkey signer. Altana's registry learns a wallet's passkey only on its first
 * transaction, so a wallet that has never transacted rebuilds the passkey from its signatures.
 */
async function ownerFor(address: string) {
  const { sdk, client } = await altana();
  const fromSignatures = async () => {
    const { id, publicKey } = await recoverPasskeyForWallet(address);
    return { address, signer: sdk.signerFromPasskey({ kind: "webauthn", id, publicKey }) };
  };
  const code = await celoReader.getCode({ address: address as Address });
  if (!code || code === "0x") return { sdk, client, owner: await fromSignatures() };
  try {
    const owner = await client.recoverFromPasskey();
    if (owner.address.toLowerCase() !== address.toLowerCase()) throw new Error("This passkey belongs to a different wallet.");
    return { sdk, client, owner };
  } catch (e) {
    if (e instanceof Error && e.message.includes("no keys registered")) return { sdk, client, owner: await fromSignatures() };
    throw e;
  }
}

export function AltanaWallet({ address, session, canManage, workspaceName }: { address: string | null; session: AltanaSessionView | null; canManage: boolean; workspaceName: string }) {
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
  </div>;
}
