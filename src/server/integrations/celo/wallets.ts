import { and, eq, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { audit } from "@/server/db/helpers";
import { newId } from "@/server/lib/ids";
import { CELO } from "./config";
import { signerFor } from "./signer";
import { agentAccount, assertCeloMainnet, operatorProblem } from "./client";
import { celoUsdcBalanceMicro } from "./wallet-balance";
export type Wallet = typeof s.wallets.$inferSelect;

export async function getWallet(db: DB, projectId: string): Promise<Wallet | null> {
  const [w] = await db.select().from(s.wallets).where(eq(s.wallets.projectId, projectId));
  return w ?? null;
}

/** True when the wallet can actually sign and move funds on this deployment. */
export function walletIsLive(w: Wallet | null | undefined): boolean {
  if (!w || w.status !== "ACTIVE" || w.blockchain !== CELO.circleBlockchain || w.dataMode !== "LIVE") return false;
  // An Altana wallet is ACTIVE only while a verified session key is in force.
  if (w.provider === "altana") return !!w.address;
  // A workspace contract enforces its own rules; the operator can only act inside them.
  if (w.provider === "growth_vault") return !!w.address && !operatorProblem();
  return !!signerFor(w);
}

async function upsertWallet(db: DB, projectId: string, v: Partial<typeof s.wallets.$inferInsert> & { provider: string; status: string }) {
  return db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`financial:${projectId}`}))`);
  if (v.circleWalletId) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`circle-wallet:${v.circleWalletId}`}))`);
  const db = tx as unknown as DB;
  const [other] = await db.select({ id: s.wallets.id }).from(s.wallets).where(and(ne(s.wallets.projectId, projectId), or(v.circleWalletId ? eq(s.wallets.circleWalletId, v.circleWalletId) : undefined, v.address ? sql`lower(${s.wallets.address}) = ${v.address.toLowerCase()}` : undefined)));
  if (other) throw new Error("That wallet already belongs to another workspace");
  const existing = await getWallet(db, projectId);
  if (existing) {
    if ((existing.circleWalletId && existing.circleWalletId !== v.circleWalletId) || (existing.address && existing.address.toLowerCase() !== v.address?.toLowerCase())) throw new Error("This workspace already has a different wallet. Use a new workspace so historical payments retain their original wallet.");
    await db.update(s.wallets).set(v).where(eq(s.wallets.id, existing.id));
    return (await getWallet(db, projectId))!;
  }
  const [row] = await db.insert(s.wallets).values({ id: newId(), projectId, blockchain: CELO.circleBlockchain, dataMode: "LIVE", ...v }).returning();
  return row;
  });
}


/** The server signer is explicitly bound to one workspace; other tenants cannot claim it. */
export async function provisionWallet(db: DB, a: {projectId: string; userId: string; projectName: string}): Promise<Wallet> {
  if (process.env.CELO_AGENT_PROJECT_ID !== a.projectId) throw new Error("Configure a dedicated Celo signer bound to this workspace ID.");
  const account = agentAccount();
  await assertCeloMainnet();
  const row = await upsertWallet(db, a.projectId, {provider: "celo_eoa", status: "ACTIVE", address: account.address, blockchain: "CELO", dataMode: "LIVE"});
  await audit(db, {projectId: a.projectId, actorType: "user", actorId: a.userId, action: "wallet.attach_celo", target: account.address});
  return row;
}
/** Records a customer's own Altana wallet. It cannot spend until a session key is verified onchain. */
export async function attachAltanaWallet(db: DB, a: {projectId: string; userId: string; address: string}): Promise<Wallet> {
  const row = await upsertWallet(db, a.projectId, {provider: "altana", status: "NOT_CONFIGURED", address: a.address, blockchain: "CELO", dataMode: "LIVE"});
  await audit(db, {projectId: a.projectId, actorType: "user", actorId: a.userId, action: "wallet.attach_altana", target: a.address});
  return row;
}
export async function attachVaultWallet(db: DB, a: {projectId: string; address: string; frozen: boolean}): Promise<Wallet> {
  const row = await upsertWallet(db, a.projectId, {provider: "growth_vault", status: "ACTIVE", address: a.address, blockchain: "CELO", dataMode: "LIVE", frozen: a.frozen});
  return row;
}
export async function setAltanaWalletStatus(db: DB, projectId: string, status: "ACTIVE" | "PAUSED") {
  await db.update(s.wallets).set({status}).where(and(eq(s.wallets.projectId, projectId), eq(s.wallets.provider, "altana")));
}
export async function attachCircleWallet(db: DB, a: {projectId: string; userId: string; circleWalletId: string}) {
  if (agentAccount().address.toLowerCase() !== a.circleWalletId.toLowerCase()) throw new Error("Address must match this deployment's Celo signer");
  return provisionWallet(db, {...a, projectName: "GrowTendril"});
}
export interface WalletBalances {walletMicro: number | null; gatewayMicro: number | null; errors: string[]}
export async function walletBalances(w: Wallet | null): Promise<WalletBalances> {
  if (!w?.address || w.blockchain !== "CELO") return {walletMicro: null, gatewayMicro: null, errors: []};
  try { const micro = await celoUsdcBalanceMicro(w.address); return {walletMicro: micro, gatewayMicro: micro, errors: []}; }
  catch { return {walletMicro: null, gatewayMicro: null, errors: ["Celo RPC balance unavailable"]}; }
}
export async function depositToGateway(_w: Wallet, _amount: string): Promise<{approveTx: string | null; depositTx: string}> {
  throw new Error("Celo x402 spends USDC directly from the wallet; Gateway deposits are not used.");
}
