import { and, eq } from "drizzle-orm";
import { concat, encodeFunctionData, erc20Abi, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/lib/ids";
import { decryptJson, encryptJson } from "@/server/security/secrets";
import { attributionSuffix, publicClient } from "./client";
import { CELO, txExplorerUrl } from "./config";
import { PAYOUT_TOKENS, TEXTILE_REACTOR, USDT, type PayoutToken } from "./corridors";
import type { ChainTxResult } from "./appkit";

export type SessionPeriod = "day" | "week" | "month";
export interface AltanaCall {to: Address; data: Hex; value: bigint}
export interface SessionGrant {calls: ({to: Address; signature: string} | {to: Address})[]; spend: {token: Address; limit: string; period: SessionPeriod}[]}
export type AltanaSession = typeof s.altanaSessions.$inferSelect;

/** Sent, but the result could not be read. The funds must stay committed until someone checks Celo. */
export class ChainOutcomeUnknownError extends Error {}
const AAD = "altana-session";
const TRANSFER = "transfer(address,uint256)";

/**
 * The onchain limits for a payout agent: named token functions and Textile's settlement contract only.
 * Local-token caps come from a live price with headroom, and only exist for corridors the owner enabled.
 */
export function sessionGrant(capMicro: bigint, period: SessionPeriod, localCaps: Partial<Record<PayoutToken, bigint>> = {}): SessionGrant {
  if (capMicro <= 0n) throw new Error("Choose a spending cap above zero");
  const local = Object.entries(localCaps) as [PayoutToken, bigint][];
  return {
    calls: [
      {to: CELO.usdc, signature: TRANSFER},
      {to: USDT.address, signature: TRANSFER},
      ...(local.length ? [{to: USDT.address, signature: "approve(address,uint256)"}, {to: TEXTILE_REACTOR}] : []),
      ...local.map(([token]) => ({to: PAYOUT_TOKENS[token].address, signature: TRANSFER})),
    ],
    spend: [
      {token: CELO.usdc, limit: capMicro.toString(), period},
      {token: USDT.address, limit: capMicro.toString(), period},
      ...local.map(([token, limit]) => ({token: PAYOUT_TOKENS[token].address, limit: limit.toString(), period})),
    ],
  };
}

export const tagged = (data: Hex): Hex => concat([data, attributionSuffix()]);
const client = async () => {
  const sdk = await import("@altananetwork/sdk");
  return {sdk, altana: sdk.createClient({chains: [sdk.CELO], agentIdentity: false})};
};

export async function openSession(db: DB, projectId: string): Promise<AltanaSession | null> {
  const [row] = await db.select().from(s.altanaSessions).where(and(eq(s.altanaSessions.projectId, projectId), eq(s.altanaSessions.status, "active")));
  return row ?? null;
}

/** Creates the agent's limited key on the server. Only its public key goes to the browser for the owner to grant. */
export async function prepareSession(db: DB, v: {projectId: string; userId: string; walletAddress: Address; capMicro: number; period: SessionPeriod; days: number; serialized: SessionGrant}) {
  if (await openSession(db, v.projectId)) throw new Error("Revoke the current session key before granting another");
  const key = generatePrivateKey();
  const {sdk} = await client();
  const publicKey = sdk.signerFromPrivateKey(key).publicKey;
  const expiry = Math.floor(Date.now() / 1000) + v.days * 86_400;
  const session = {walletAddress: v.walletAddress, publicKey, permissions: v.serialized, expiry};
  await db.delete(s.altanaSessions).where(and(eq(s.altanaSessions.projectId, v.projectId), eq(s.altanaSessions.status, "pending")));
  const [row] = await db.insert(s.altanaSessions).values({id: newId(), projectId: v.projectId, walletAddress: v.walletAddress, publicKey, sealedKey: encryptJson({key}, `${AAD}:${v.projectId}`), session, capMicro: v.capMicro, period: v.period, expiresAt: new Date(expiry * 1000), status: "pending", createdBy: v.userId}).returning();
  return {id: row.id, publicKey, sessionAddress: privateKeyToAccount(key).address, expiry, permissions: v.serialized};
}

/** The browser's word is not proof: read the wallet contract before treating a key as granted or revoked. */
export async function keyIsOnAccount(walletAddress: string, publicKey: string): Promise<boolean> {
  if (!isAddress(walletAddress)) return false;
  const {sdk} = await client();
  return sdk.accountHasKey(publicClient() as never, walletAddress, sdk.keyHashForSessionOrKey(publicKey as Hex));
}

async function liveSession(db: DB, projectId: string) {
  const row = await openSession(db, projectId);
  if (!row) throw new Error("No active Altana session key. Grant one from the Wallet page.");
  if (row.expiresAt.getTime() <= Date.now()) throw new Error("The Altana session key has expired. Grant a new one from the Wallet page.");
  const {sdk, altana} = await client();
  const {key} = decryptJson(row.sealedKey, `${AAD}:${projectId}`);
  const session = sdk.deserializeSession(row.session as never, sdk.signerFromPrivateKey(key as Hex));
  return {session, altana, native: sdk.NATIVE_TOKEN};
}

/** A refused quote proves nothing was sent. After that point, a lost response is treated as an unknown outcome. */
export async function altanaExecute(db: DB, projectId: string, calls: AltanaCall[]): Promise<{txHash: Hex | null; state: "pending" | "success" | "error"}> {
  const {session, altana, native} = await liveSession(db, projectId);
  await altana.quoteExecute({session, calls, feeToken: native});
  try {
    const result = await altana.execute({session, calls, feeToken: native});
    return {txHash: result.transactionHash ?? null, state: result.status === "CONFIRMED" ? "success" : result.status === "FAILED" ? "error" : "pending"};
  } catch {
    throw new ChainOutcomeUnknownError("The Altana relay did not confirm this payment. It may still land.");
  }
}

export async function altanaSendUsdc(db: DB, projectId: string, p: {to: Address; amountMicro: bigint}): Promise<ChainTxResult> {
  const data = tagged(encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [p.to, p.amountMicro]}));
  const r = await altanaExecute(db, projectId, [{to: CELO.usdc, data, value: 0n}]);
  return {state: r.state, txHash: r.txHash, explorerUrl: r.txHash ? txExplorerUrl("Celo", r.txHash) : null, steps: [{name: "Altana USDC transfer", state: r.state, txHash: r.txHash ?? undefined}]};
}
