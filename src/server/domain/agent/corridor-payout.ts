import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type Log } from "viem";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { fmtUsdc } from "@/lib/money";
import { newId } from "@/server/lib/ids";
import { transition } from "@/server/domain/agent/ledger";
import { openException } from "@/server/domain/reconcile/exceptions";
import { altanaExecute, ChainOutcomeUnknownError, tagged, type AltanaCall } from "@/server/integrations/celo/altana";
import { executeVaultCorridor, vaultMinPayout } from "@/server/integrations/celo/protocol";
import { agentAccount, agentWalletClient, assertCeloMainnet, publicClient } from "@/server/integrations/celo/client";
import { txExplorerUrl } from "@/server/integrations/celo/config";
import { formatPayout, isPayoutToken, PAYOUT_TOKENS, TEXTILE_REACTOR, USDT, type PayoutToken } from "@/server/integrations/celo/corridors";
import { reportCorridorTx, requestCorridorQuote, type CorridorQuote, type TakerProofSigner } from "@/server/integrations/celo/textile";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** A delivery that started this long ago with no payout hash did not finish in its own process. */
const DELIVERY_GRACE_MS = 5 * 60_000;
type Tx = typeof s.transactions.$inferSelect;
type Wallet = typeof s.wallets.$inferSelect;
export interface CorridorResult {state: string; txHash: string | null; message: string}
export interface TokenMove {token: string; from: string; to: string; value: bigint}

export function tokenMoves(logs: Pick<Log, "address" | "topics" | "data">[]): TokenMove[] {
  return logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length >= 3).map((l) => ({
    token: l.address.toLowerCase(), from: `0x${l.topics[1]!.slice(-40)}`.toLowerCase(), to: `0x${l.topics[2]!.slice(-40)}`.toLowerCase(), value: BigInt(l.data),
  }));
}
const sum = (moves: TokenMove[]) => moves.reduce((n, m) => n + m.value, 0n);

/** The conversion spent no more USD₮ than approved and paid the quoted local amount into the wallet. */
export function swapMatches(moves: TokenMove[], e: {wallet: string; tokenAddress: string; buyAmount: bigint; maxSellMicro: bigint}) {
  const wallet = e.wallet.toLowerCase();
  const sold = sum(moves.filter((m) => m.token === USDT.address.toLowerCase() && m.from === wallet));
  const received = sum(moves.filter((m) => m.token === e.tokenAddress.toLowerCase() && m.to === wallet));
  return sold > 0n && sold <= e.maxSellMicro && received >= e.buyAmount;
}

/** The recipient got exactly the quoted amount, and this wallet sent that token nowhere else. */
export function deliveryMatches(moves: TokenMove[], e: {wallet: string; recipient: string; tokenAddress: string; buyAmount: bigint}) {
  const out = moves.filter((m) => m.token === e.tokenAddress.toLowerCase() && m.from === e.wallet.toLowerCase());
  return sum(out) === e.buyAmount && out.every((m) => m.to === e.recipient.toLowerCase());
}

async function receipt(hash: Hash, timeout = 60_000) {
  try { return await publicClient().waitForTransactionReceipt({hash, timeout, retryCount: 2}); } catch { return null; }
}
async function unresolved(db: DB, tx: Tx, hash: string | null, detail: string) {
  const [current] = await db.select({state: s.transactions.state}).from(s.transactions).where(eq(s.transactions.id, tx.id));
  if (current?.state === "EXECUTING" || current?.state === "SUBMITTED") await transition(db, tx.id, "EXCEPTION", {chainCheck: "mismatch", chainCheckedAt: new Date(), error: detail}, detail);
  await openException(db, {scope: "wallet", projectId: tx.projectId, kind: "payout_mismatch", ref: tx.id, transactionId: tx.id, txHash: hash, amountMicro: tx.amountMicro, counterparty: tx.recipient, detail: `${detail}${hash ? ` ${txExplorerUrl("Celo", hash)}` : ""}`});
  return {state: "EXCEPTION", txHash: hash, message: detail};
}
async function settled(db: DB, tx: Tx, rowId: string, hash: string, token: PayoutToken, buyAmount: bigint): Promise<CorridorResult> {
  await db.update(s.corridorPayouts).set({status: "paid", payoutTxHash: hash, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  const note = `Checked on Celo: ${formatPayout(token, buyAmount)} reached the recipient`;
  await transition(db, tx.id, "SETTLED", {chainCheck: "verified", chainCheckedAt: new Date()}, note);
  return {state: "SETTLED", txHash: hash, message: note};
}

async function viaAltana(db: DB, tx: Tx, wallet: Wallet, token: PayoutToken, quote: CorridorQuote, rowId: string): Promise<CorridorResult> {
  const taker = wallet.address as Address;
  const recipient = tx.recipient as Address;
  const allowance = await publicClient().readContract({address: USDT.address, abi: erc20Abi, functionName: "allowance", args: [taker, TEXTILE_REACTOR]});
  const approve = (amount: bigint): AltanaCall => ({to: USDT.address, data: tagged(encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [TEXTILE_REACTOR, amount]})), value: 0n});
  // One atomic batch: either the creator is paid in local currency or no funds move.
  const calls: AltanaCall[] = [
    ...(allowance > 0n ? [approve(0n)] : []), approve(quote.takerPays),
    {to: quote.swap.to, data: quote.tagged ? quote.swap.data : tagged(quote.swap.data), value: 0n},
    {to: PAYOUT_TOKENS[token].address, data: tagged(encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [recipient, quote.buyAmount]})), value: 0n},
  ];
  const sent = await altanaExecute(db, tx.projectId, calls);
  if (sent.state === "error") throw new Error("The Altana wallet rejected this payout. No funds moved.");
  if (!sent.txHash) return unresolved(db, tx, null, "The Altana relay accepted this payout without returning a transaction hash. Check the wallet's Celo history.");
  await db.update(s.corridorPayouts).set({status: "swapped", swapTxHash: sent.txHash, payoutTxHash: sent.txHash, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  await transition(db, tx.id, "SUBMITTED", {txHash: sent.txHash, explorerUrl: txExplorerUrl("Celo", sent.txHash)}, `Textile FX conversion to ${token} submitted from Altana wallet`);
  await reportCorridorTx(quote, sent.txHash);
  return {state: await confirmCorridor(db, tx.id), txHash: sent.txHash, message: `Payout in ${token} submitted`};
}

async function viaAgentWallet(db: DB, tx: Tx, wallet: Wallet, token: PayoutToken, first: CorridorQuote, rowId: string): Promise<CorridorResult> {
  const taker = wallet.address as Address;
  const recipient = tx.recipient as Address;
  const client = agentWalletClient();
  let quote = first;
  const allowance = await publicClient().readContract({address: USDT.address, abi: erc20Abi, functionName: "allowance", args: [taker, TEXTILE_REACTOR]});
  if (allowance < quote.takerPays) {
    // USD₮-style tokens can reject a nonzero-to-nonzero approval. The reactor can only ever pull this exact amount.
    for (const amount of allowance > 0n ? [0n, quote.takerPays] : [quote.takerPays]) {
      const hash = await client.writeContract({address: USDT.address, abi: erc20Abi, functionName: "approve", args: [TEXTILE_REACTOR, amount]});
      const approved = await receipt(hash);
      if (approved?.status !== "success") throw new Error("The USD₮ approval did not confirm. No funds moved.");
    }
  }
  if (Date.now() >= quote.expiresAt) {
    quote = await requestCorridorQuote({token, sellMicro: BigInt(tx.amountMicro), taker, signProof: proofSigner()});
    if (quote.takerPays > first.takerPays) throw new Error("The refreshed quote costs more than the approved allowance. No funds moved.");
    await db.update(s.corridorPayouts).set({rfqId: quote.rfqId, takerPaysMicro: Number(quote.takerPays), buyAmount: quote.buyAmount.toString(), feeAmount: quote.feeAmount.toString(), rateRay: quote.rateRay, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  }
  // A quote with Textile's tag already carries ours; an explicit empty suffix prevents a second one.
  let swapHash: Hash;
  try {
    swapHash = await client.sendTransaction({to: quote.swap.to, data: quote.swap.data, value: 0n, ...(quote.tagged ? {dataSuffix: "0x" as Hex} : {})});
  } catch {
    throw new ChainOutcomeUnknownError("The Celo RPC did not confirm that the conversion was sent. It may still land.");
  }
  await db.update(s.corridorPayouts).set({status: "swapped", swapTxHash: swapHash, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  await transition(db, tx.id, "SUBMITTED", {txHash: swapHash, explorerUrl: txExplorerUrl("Celo", swapHash)}, `Textile FX conversion to ${token} submitted`);
  await reportCorridorTx(quote, swapHash);
  const swapped = await receipt(swapHash);
  if (!swapped) return {state: "SUBMITTED", txHash: swapHash, message: "Conversion submitted; confirmation pending"};
  if (swapped.status !== "success") {
    await db.update(s.corridorPayouts).set({status: "failed", updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
    await transition(db, tx.id, "FAILED", {chainCheck: "verified", chainCheckedAt: new Date(), error: "Conversion reverted on Celo"}, "Conversion reverted; no USD₮ moved");
    return {state: "FAILED", txHash: swapHash, message: "The conversion reverted on Celo. No USD₮ moved."};
  }
  if (!swapMatches(tokenMoves(swapped.logs), {wallet: taker, tokenAddress: PAYOUT_TOKENS[token].address, buyAmount: quote.buyAmount, maxSellMicro: BigInt(tx.amountMicro)}))
    return unresolved(db, tx, swapHash, "The conversion settled, but Celo does not show the quoted amounts.");
  let payoutHash: Hash;
  try {
    payoutHash = await client.writeContract({address: PAYOUT_TOKENS[token].address, abi: erc20Abi, functionName: "transfer", args: [recipient, quote.buyAmount]});
  } catch {
    return unresolved(db, tx, swapHash, `Converted ${formatPayout(token, quote.buyAmount)}, but delivery to the recipient was not sent. The funds remain in the agent wallet.`);
  }
  await db.update(s.corridorPayouts).set({payoutTxHash: payoutHash, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  await db.update(s.transactions).set({txHash: payoutHash, batchTxHash: swapHash, explorerUrl: txExplorerUrl("Celo", payoutHash), updatedAt: new Date()}).where(eq(s.transactions.id, tx.id));
  return {state: await confirmCorridor(db, tx.id), txHash: payoutHash, message: `Payout in ${token} submitted`};
}

/** The workspace contract converts and delivers atomically, and enforces the minimum the approver signed. */
async function viaWorkspace(db: DB, tx: Tx, token: PayoutToken, quote: CorridorQuote, rowId: string): Promise<CorridorResult> {
  const minimum = await vaultMinPayout(db, tx);
  if (quote.buyAmount < minimum) throw new Error(`The live rate is below the minimum approved for this payout (${formatPayout(token, minimum)}). No funds moved.`);
  const hash = await executeVaultCorridor(db, tx, quote.swap.data);
  await db.update(s.corridorPayouts).set({status: "swapped", swapTxHash: hash, payoutTxHash: hash, updatedAt: new Date()}).where(eq(s.corridorPayouts.id, rowId));
  await transition(db, tx.id, "SUBMITTED", {txHash: hash, explorerUrl: txExplorerUrl("Celo", hash)}, `Textile FX conversion to ${token} submitted from workspace contract`);
  await reportCorridorTx(quote, hash);
  await receipt(hash);
  return {state: await confirmCorridor(db, tx.id), txHash: hash, message: `Payout in ${token} submitted`};
}

const proofSigner = (): TakerProofSigner => (challenge) => agentAccount().signTypedData(challenge);

/** Convert an approved USD₮ amount on Textile FX and deliver the local stablecoin to the approved recipient. */
export async function executeCorridorPayout(db: DB, tx: Tx, wallet: Wallet): Promise<CorridorResult> {
  if (!isPayoutToken(tx.payoutToken) || !tx.recipient || !wallet.address) throw new Error("This payout has no valid local currency or recipient");
  const token = tx.payoutToken;
  const taker = wallet.address as Address;
  const sellMicro = BigInt(tx.amountMicro);
  await assertCeloMainnet();
  const balance = await publicClient().readContract({address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [taker]});
  if (balance < sellMicro) throw new Error(`Local-currency payouts are funded in USD₮. This wallet holds ${fmtUsdc(Number(balance))} and needs ${fmtUsdc(tx.amountMicro)}.`);
  const isAltana = wallet.provider === "altana";
  const isWorkspace = wallet.provider === "growth_vault";
  const quote = await requestCorridorQuote({token, sellMicro, taker, signProof: isAltana || isWorkspace ? undefined : proofSigner()});
  const rowId = newId();
  await db.insert(s.corridorPayouts).values({id: rowId, transactionId: tx.id, projectId: tx.projectId, token, tokenAddress: PAYOUT_TOKENS[token].address, rfqId: quote.rfqId, takerPaysMicro: Number(quote.takerPays), buyAmount: quote.buyAmount.toString(), feeAmount: quote.feeAmount.toString(), rateRay: quote.rateRay, status: "quoted"});
  if (isWorkspace) return viaWorkspace(db, tx, token, quote, rowId);
  return isAltana ? viaAltana(db, tx, wallet, token, quote, rowId) : viaAgentWallet(db, tx, wallet, token, quote, rowId);
}

/** Settle only from what Celo shows. An interrupted delivery is escalated and never sent twice automatically. */
export async function confirmCorridor(db: DB, txId: string): Promise<string> {
  const [tx] = await db.select().from(s.transactions).where(eq(s.transactions.id, txId));
  if (!tx || tx.state !== "SUBMITTED") return tx?.state ?? "FAILED";
  const [row] = await db.select().from(s.corridorPayouts).where(eq(s.corridorPayouts.transactionId, txId));
  const [wallet] = tx.walletId ? await db.select().from(s.wallets).where(eq(s.wallets.id, tx.walletId)) : [];
  if (!row || !wallet?.address || !tx.recipient || !isPayoutToken(row.token)) return (await unresolved(db, tx, tx.txHash, "This payout is missing its conversion record.")).state;
  const buyAmount = BigInt(row.buyAmount);
  const expected = {wallet: wallet.address, recipient: tx.recipient, tokenAddress: row.tokenAddress, buyAmount};
  if (!row.payoutTxHash) {
    if (!row.swapTxHash) return "SUBMITTED";
    const swap = await publicClient().getTransactionReceipt({hash: row.swapTxHash as Hash}).catch(() => null);
    if (!swap) return "SUBMITTED";
    if (swap.status !== "success") {
      await db.update(s.corridorPayouts).set({status: "failed", updatedAt: new Date()}).where(eq(s.corridorPayouts.id, row.id));
      await transition(db, tx.id, "FAILED", {chainCheck: "verified", chainCheckedAt: new Date(), error: "Conversion reverted on Celo"}, "Conversion reverted; no USD₮ moved");
      return "FAILED";
    }
    if (Date.now() - row.updatedAt.getTime() < DELIVERY_GRACE_MS) return "SUBMITTED";
    return (await unresolved(db, tx, row.swapTxHash, `Converted ${formatPayout(row.token, buyAmount)}, but delivery did not complete. The funds remain in the wallet.`)).state;
  }
  const paid = await publicClient().getTransactionReceipt({hash: row.payoutTxHash as Hash}).catch(() => null);
  if (!paid) return "SUBMITTED";
  const moves = tokenMoves(paid.logs);
  const atomicBatch = row.swapTxHash === row.payoutTxHash;
  if (paid.status !== "success") {
    if (atomicBatch) {
      await db.update(s.corridorPayouts).set({status: "failed", updatedAt: new Date()}).where(eq(s.corridorPayouts.id, row.id));
      await transition(db, tx.id, "FAILED", {chainCheck: "verified", chainCheckedAt: new Date(), error: "Payout reverted on Celo"}, "Atomic payout reverted; no funds moved");
      return "FAILED";
    }
    return (await unresolved(db, tx, row.payoutTxHash, `Converted ${formatPayout(row.token, buyAmount)}, but the delivery transaction reverted. The funds remain in the agent wallet.`)).state;
  }
  const delivered = deliveryMatches(moves, expected) && (!atomicBatch || swapMatches(moves, {wallet: wallet.address, tokenAddress: row.tokenAddress, buyAmount, maxSellMicro: BigInt(tx.amountMicro)}));
  if (!delivered) return (await unresolved(db, tx, row.payoutTxHash, `Celo does not show exactly ${formatPayout(row.token, buyAmount)} reaching the approved recipient.`)).state;
  return (await settled(db, tx, row.id, row.payoutTxHash, row.token, buyAmount)).state;
}
