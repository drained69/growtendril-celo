import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { BaseError, ContractFunctionRevertedError, erc20Abi, getAddress, isAddress, keccak256, toHex, zeroAddress, type Abi, type Address, type Hash, type Hex } from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import { canonical } from "@growth-tools/evidence";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { audit } from "@/server/db/helpers";
import { newId } from "@/server/lib/ids";
import { GROWTH_FACTORY_ABI, GROWTH_LEDGER_ABI, GROWTH_WORKSPACE_ABI } from "@/lib/celo-protocol-abi";
import { merkleRoot } from "@/lib/merkle";
import { ChainOutcomeUnknownError } from "./altana";
import type { ChainTxResult } from "./appkit";
import { operatorAccount, operatorProblem, operatorWalletClient, publicClient } from "./client";
import { CELO, txExplorerUrl } from "./config";
import { formatPayout, isPayoutToken, PAYOUT_TOKENS, USDT, type PayoutToken } from "./corridors";
import { previewCorridor } from "./textile";
import { BUDGET_PERIOD_MS } from "@/lib/budget";

export const CATEGORIES = ["research", "services", "kol", "bounty", "content", "community", "treasury"] as const;
export const INTENT_STATE = { None: 0, Pending: 1, Approved: 2, Executed: 3, Rejected: 4, Cancelled: 5 } as const;
const ROLE_OPERATOR = 4;
const INTENT_LIFETIME_SECONDS = 72n * 3600n;
/** The lowest local amount an approval accepts, relative to the live price when it was proposed. */
const MIN_PAYOUT_BPS = 9_700n;
/** Below this share of today's price, a conversion's onchain minimum is refused before the owner signs. */
const FAIR_FLOOR_BPS = 8_500n;
const MAX_RECORDS = 1_000;
const workspaceAbi = GROWTH_WORKSPACE_ABI as Abi;
const ledgerAbi = GROWTH_LEDGER_ABI as Abi;
type Tx = typeof s.transactions.$inferSelect;
type Log = (agent: string, message: string) => void;
type OnchainIntent = {state: number; approver: Address; amount: bigint; recipient: Address};

export function protocolAddresses(): {factory: Address; ledger: Address} | null {
  const factory = process.env.CELO_GROWTH_FACTORY?.trim(), ledger = process.env.CELO_GROWTH_LEDGER?.trim();
  return factory && ledger && isAddress(factory) && isAddress(ledger) ? {factory: getAddress(factory), ledger: getAddress(ledger)} : null;
}
export const protocolId = (kind: "mission" | "experiment" | "intent", id: string): Hex => keccak256(toHex(`growtendril:${kind}:${id}`));
export const workspaceRef = (projectId: string): Hex => keccak256(toHex(`growtendril:workspace:${projectId}`));
export const intentIdFor = (txId: string, amountMicro: number): Hex => protocolId("intent", `${txId}:${amountMicro}`);
const mask = (list: readonly string[]) => CATEGORIES.reduce((bits, category, index) => list.includes(category) ? bits | (1 << index) : bits, 0);

export function onchainPolicy(p: {autonomyEnabled?: boolean; maxTransactionMicro: number; dailySpendMicro: number; hardCeilingMicro: number; autonomousCategories: string[]; approvalCategories: string[]}) {
  return {autonomyEnabled: p.autonomyEnabled === true, maxTransaction: BigInt(p.maxTransactionMicro), dailySpend: BigInt(p.dailySpendMicro), hardCeiling: BigInt(p.hardCeilingMicro), autonomousCategories: mask(p.autonomousCategories), approvalCategories: mask(p.approvalCategories)};
}

/** What the owner can do about each refusal, in their terms rather than the contract's. */
const REFUSAL_HELP: Record<string, string> = {
  "hard ceiling": "This payment is bigger than the largest single payment your Payout account allows. Raise it in Settings → Budget, then confirm it on the Payout account page.",
  "category not allowed": "Your Payout account doesn't allow this kind of spending yet. Confirm your limits on the Payout account page.",
  "mission inactive": "This month's budget isn't confirmed in your Payout account yet. Confirm it on the Payout account page.",
  "mission budget": "This would go over this month's budget in your Payout account. Raise the monthly budget in Settings → Budget, then confirm it on the Payout account page.",
  "experiment budget": "This would go over the test's budget. Raise the test's budget or lower the payment.",
  "experiment inactive": "This test was stopped in your Payout account.",
  "frozen": "Payments from your Payout account are paused. Turn them back on from the Payout account page.",
  "not authorized": "GrowTendril isn't allowed to suggest payments from your Payout account. Give it access again on the Payout account page.",
  "payee hold": "You added this recipient yourself less than 24 hours ago, so someone else must approve it, or you can approve after the hold.",
  "transfer failed": "Your Payout account doesn't hold enough money for this payment. Add money on the Payout account page.",
};

/** Contract reverts are the protocol's policy decisions, so their short reason is safe and useful to show. */
function refused(error: unknown): Error {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    const reason = revert instanceof ContractFunctionRevertedError ? revert.reason : null;
    if (reason && REFUSAL_HELP[reason]) return new Error(REFUSAL_HELP[reason]);
    if (reason && /^[a-z ]{3,48}$/i.test(reason)) return new Error(`The workspace contract refused this: ${reason}.`);
  }
  return new Error("The workspace contract could not be reached. Nothing was sent.");
}

async function operatorSend(address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hash> {
  const client = publicClient();
  let request: unknown;
  try {
    ({request} = await client.simulateContract({account: operatorAccount(), address, abi, functionName, args}));
  } catch (error) {
    throw refused(error);
  }
  let hash: Hash;
  try {
    hash = await operatorWalletClient().writeContract(request as never);
  } catch {
    throw new ChainOutcomeUnknownError("The Celo RPC did not confirm that this transaction was sent. It may still land.");
  }
  return hash;
}
async function operatorConfirm(address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await operatorSend(address, abi, functionName, args);
  const receipt = await publicClient().waitForTransactionReceipt({hash, timeout: 60_000, retryCount: 2});
  if (receipt.status !== "success") throw new Error(`The ${functionName} transaction reverted on Celo.`);
  return hash;
}
const readWorkspace = <T>(address: Address, functionName: string, args: unknown[] = []) => publicClient().readContract({address, abi: workspaceAbi, functionName, args}) as Promise<T>;
const readIntent = (workspace: Address, id: Hex) => readWorkspace<OnchainIntent>(workspace, "intentOf", [id]);

/** A workspace is linked only if it came from our factory, was created for this project, and grants the operator role. */
export async function verifyWorkspace(projectId: string, address: string) {
  const protocol = protocolAddresses();
  if (!protocol) throw new Error("The GrowTendril protocol is not deployed yet");
  if (!isAddress(address)) throw new Error("The workspace address is invalid");
  const workspace = getAddress(address);
  const client = publicClient();
  // The browser confirms creation on one RPC node; the next read can reach a node that is a block behind.
  let isWorkspace = false;
  for (let attempt = 0; attempt < 6 && !isWorkspace; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    isWorkspace = await client.readContract({address: protocol.factory, abi: GROWTH_FACTORY_ABI, functionName: "isWorkspace", args: [workspace]});
  }
  if (!isWorkspace) throw new Error("This address was not created by the GrowTendril factory");
  const [ref, operatorOk] = await Promise.all([readWorkspace<Hex>(workspace, "ref"), readWorkspace<boolean>(workspace, "hasRole", [operatorAccount().address, ROLE_OPERATOR])]);
  if (ref !== workspaceRef(projectId)) throw new Error("This contract belongs to a different workspace");
  if (!operatorOk) throw new Error("This contract has not granted GrowTendril's operator role");
  return workspace;
}

async function walletOf(db: DB, tx: Tx): Promise<Address> {
  const [wallet] = tx.walletId ? await db.select().from(s.wallets).where(eq(s.wallets.id, tx.walletId)) : await db.select().from(s.wallets).where(eq(s.wallets.projectId, tx.projectId));
  if (wallet?.provider !== "growth_vault" || !wallet.address) throw new Error("This workspace has no linked contract");
  return wallet.address as Address;
}

/** Publishes the payment for human approval. Anything outside the onchain rules reverts here. */
export async function ensureVaultIntent(db: DB, tx: Tx, amountMicro: number): Promise<{workspace: Address; intentId: Hex; state: number}> {
  const workspace = await walletOf(db, tx);
  const intentId = intentIdFor(tx.id, amountMicro);
  const existing = await readIntent(workspace, intentId);
  if (existing.state !== INTENT_STATE.None) return {workspace, intentId, state: existing.state};
  if (!tx.missionId || !tx.experimentId || !tx.recipient) throw new Error("This payment has no mission, experiment or recipient");
  const missionId = protocolId("mission", tx.missionId), experimentId = protocolId("experiment", tx.experimentId);
  const mission = await readWorkspace<readonly bigint[]>(workspace, "missions", [missionId]);
  if (mission[3] === 0n) throw new Error("Publish this mission to your workspace contract on the Wallet page first.");
  const experiment = await readWorkspace<readonly unknown[]>(workspace, "experiments", [experimentId]);
  if (experiment[0] === `0x${"0".repeat(64)}`) {
    const [row] = await db.select().from(s.experiments).where(eq(s.experiments.id, tx.experimentId));
    if (!row) throw new Error("Experiment not found");
    await operatorConfirm(workspace, workspaceAbi, "openExperiment", [experimentId, missionId, BigInt(row.budgetMicro), keccak256(toHex(canonical({id: row.id, title: row.title, hypothesis: row.hypothesis ?? null, successEvent: row.successEvent})))]);
  }
  const payee = await readWorkspace<readonly [Address, bigint]>(workspace, "payees", [tx.recipient]);
  if (payee[1] === 0n) await operatorConfirm(workspace, workspaceAbi, "registerPayee", [tx.recipient]);
  let minPayout = 0n;
  if (tx.payoutToken) {
    if (!isPayoutToken(tx.payoutToken)) throw new Error("Unsupported payout currency");
    const price = await previewCorridor(tx.payoutToken, BigInt(amountMicro));
    if (!price.buyAmount) throw new Error("No Textile FX maker is pricing this corridor right now");
    minPayout = BigInt(price.buyAmount) * MIN_PAYOUT_BPS / 10_000n;
  }
  const [receipt] = await db.select({digest: s.decisionReceipts.digest}).from(s.decisionReceipts).where(eq(s.decisionReceipts.decisionId, tx.decisionId));
  const evidenceHash = receipt && /^[0-9a-f]{64}$/.test(receipt.digest) ? `0x${receipt.digest}` as Hex : keccak256(toHex(tx.decisionId));
  const category = CATEGORIES.indexOf(tx.budgetCategory as (typeof CATEGORIES)[number]);
  if (category < 0) throw new Error("This payment has an unsupported budget category");
  const block = await publicClient().getBlock();
  await operatorConfirm(workspace, workspaceAbi, "propose", [{
    id: intentId, missionId, experimentId, recipient: tx.recipient, token: tx.payoutToken ? USDT.address : CELO.usdc,
    payoutToken: tx.payoutToken && isPayoutToken(tx.payoutToken) ? PAYOUT_TOKENS[tx.payoutToken].address : zeroAddress,
    amount: BigInt(amountMicro), expiresAt: block.timestamp + INTENT_LIFETIME_SECONDS, category, kind: 0, minPayout, evidenceHash,
  }]);
  return {workspace, intentId, state: (await readIntent(workspace, intentId)).state};
}

/** The founder's approval must exist onchain before the app records it as approved. */
export interface VaultIntentTerms {recipient: Address; amount: bigint; payoutToken: Address; minPayout: bigint}

/**
 * Why the owner must not sign this intent, or null. The intent may have been written by a stolen
 * operator key, so its terms are checked against this payment and against today's rate.
 */
export function vaultTermsProblem(intent: VaultIntentTerms, expected: {recipient: string | null; amountMicro: number; payoutToken: PayoutToken | null; fairBuyAmount: bigint | null}): string | null {
  if (intent.recipient.toLowerCase() !== expected.recipient?.toLowerCase() || intent.amount !== BigInt(expected.amountMicro)) return "The payment recorded on Celo does not match this approval. Reject it.";
  const payoutAddress = expected.payoutToken ? PAYOUT_TOKENS[expected.payoutToken].address : zeroAddress;
  if (intent.payoutToken.toLowerCase() !== payoutAddress.toLowerCase()) return "The payout currency recorded on Celo does not match this approval. Reject it.";
  if (!expected.payoutToken) return null;
  if (expected.fairBuyAmount === null) return "Textile FX is not pricing this currency right now, so the minimum payout cannot be checked. Try again later.";
  const floor = expected.fairBuyAmount * FAIR_FLOOR_BPS / 10_000n;
  if (intent.minPayout < floor) return `The minimum payout recorded on Celo (${formatPayout(expected.payoutToken, intent.minPayout)}) is far below today's rate (${formatPayout(expected.payoutToken, expected.fairBuyAmount)}). Reject this payment.`;
  return null;
}

export async function checkVaultIntentTerms(db: DB, tx: Tx, amountMicro: number): Promise<string | null> {
  const workspace = await walletOf(db, tx);
  const intent = await readWorkspace<VaultIntentTerms>(workspace, "intentOf", [intentIdFor(tx.id, amountMicro)]);
  const payoutToken = tx.payoutToken && isPayoutToken(tx.payoutToken) ? tx.payoutToken : null;
  const fairBuyAmount = payoutToken ? await previewCorridor(payoutToken, BigInt(amountMicro)).then((p) => p.buyAmount ? BigInt(p.buyAmount) : null).catch(() => null) : null;
  return vaultTermsProblem(intent, {recipient: tx.recipient, amountMicro, payoutToken, fairBuyAmount});
}

export async function assertVaultApproved(db: DB, tx: Tx, amountMicro: number) {
  const workspace = await walletOf(db, tx);
  const intent = await readIntent(workspace, intentIdFor(tx.id, amountMicro));
  if (intent.state !== INTENT_STATE.Approved) throw new Error("Approve this payment in your wallet first.");
  if (intent.recipient.toLowerCase() !== tx.recipient?.toLowerCase() || intent.amount !== BigInt(amountMicro)) throw new Error("The onchain approval does not match this payment.");
}

export async function openVaultIntents(db: DB, tx: Tx, amounts: readonly number[]): Promise<{workspace: Address; intentIds: Hex[]}> {
  const workspace = await walletOf(db, tx);
  const ids = amounts.map((amount) => intentIdFor(tx.id, amount));
  const intents = await Promise.all(ids.map((id) => readIntent(workspace, id)));
  return {workspace, intentIds: ids.filter((_, index) => intents[index].state === INTENT_STATE.Pending || intents[index].state === INTENT_STATE.Approved)};
}

export async function executeVaultPayment(db: DB, tx: Tx): Promise<ChainTxResult> {
  const {workspace, intentId, state} = await ensureVaultIntent(db, tx, tx.amountMicro);
  if (state !== INTENT_STATE.Approved) throw new Error("This payment still needs approval in the workspace contract.");
  const txHash = await operatorSend(workspace, workspaceAbi, "execute", [intentId]);
  return {state: "pending", txHash, explorerUrl: txExplorerUrl("Celo", txHash), steps: [{name: "Workspace contract payout", state: "pending", txHash}]};
}
export async function executeVaultCorridor(db: DB, tx: Tx, swapData: Hex): Promise<Hash> {
  const {workspace, intentId, state} = await ensureVaultIntent(db, tx, tx.amountMicro);
  if (state !== INTENT_STATE.Approved) throw new Error("This payment still needs approval in the workspace contract.");
  return operatorSend(workspace, workspaceAbi, "executeCorridor", [intentId, swapData]);
}
export async function vaultMinPayout(db: DB, tx: Tx): Promise<bigint> {
  const workspace = await walletOf(db, tx);
  return (await readWorkspace<{minPayout: bigint}>(workspace, "intentOf", [intentIdFor(tx.id, tx.amountMicro)])).minPayout;
}

export interface OutcomeEvent {id: string; eventType: string; visitorId: string | null; valueMicro: number}
export interface OutcomeTotals {customers: bigint; activated: bigint; paying: bigint; revenue: bigint; refunded: bigint}
export function aggregateOutcomes(events: readonly OutcomeEvent[], onchain?: OutcomeTotals): OutcomeTotals {
  const who = (e: OutcomeEvent) => e.visitorId ?? e.id;
  const customers = new Set<string>(), activated = new Set<string>(), paying = new Set<string>();
  let revenue = 0n, refunded = 0n;
  for (const e of events) {
    if (e.eventType === "visit") continue;
    if (e.eventType === "refund") { refunded += BigInt(e.valueMicro); continue; }
    customers.add(who(e));
    if (e.eventType === "purchase") { paying.add(who(e)); revenue += BigInt(e.valueMicro); }
    else activated.add(who(e));
  }
  const highest = (a: bigint, b?: bigint) => b !== undefined && b > a ? b : a;
  const totalRevenue = highest(revenue, onchain?.revenue);
  const totalCustomers = highest(BigInt(customers.size), onchain?.customers);
  const cap = (value: bigint, max: bigint) => value > max ? max : value;
  return {customers: totalCustomers, activated: cap(highest(BigInt(activated.size), onchain?.activated), totalCustomers), paying: cap(highest(BigInt(paying.size), onchain?.paying), totalCustomers), revenue: totalRevenue, refunded: cap(highest(refunded, onchain?.refunded), totalRevenue)};
}

async function commitRecords(db: DB, projectId: string, workspace: Address, ledger: Address, log: Log) {
  const [last] = await db.select().from(s.protocolCheckpoints).where(eq(s.protocolCheckpoints.projectId, projectId)).orderBy(desc(s.protocolCheckpoints.number)).limit(1);
  const since = last?.coveredUntil ?? new Date(0);
  const [receipts, evidence, learnings] = await Promise.all([
    db.select({id: s.decisionReceipts.id, digest: s.decisionReceipts.digest, at: s.decisionReceipts.finalizedAt}).from(s.decisionReceipts).where(and(eq(s.decisionReceipts.projectId, projectId), isNotNull(s.decisionReceipts.finalizedAt), gt(s.decisionReceipts.finalizedAt, since))).orderBy(asc(s.decisionReceipts.finalizedAt)).limit(MAX_RECORDS),
    db.select({id: s.evidence.id, url: s.evidence.sourceUrl, excerpt: s.evidence.excerpt, signal: s.evidence.signalType, at: s.evidence.createdAt}).from(s.evidence).where(and(eq(s.evidence.projectId, projectId), gt(s.evidence.createdAt, since))).orderBy(asc(s.evidence.createdAt)).limit(MAX_RECORDS),
    db.select({id: s.learnings.id, missionId: s.learnings.missionId, findings: s.learnings.findings, reallocations: s.learnings.reallocations, at: s.learnings.createdAt}).from(s.learnings).where(and(eq(s.learnings.projectId, projectId), gt(s.learnings.createdAt, since))).orderBy(asc(s.learnings.createdAt)).limit(MAX_RECORDS),
  ]);
  const records = [
    ...receipts.map((r) => ({at: r.at!, leaf: keccak256(toHex(`receipt:${r.id}:${r.digest}`))})),
    ...evidence.map((e) => ({at: e.at, leaf: keccak256(toHex(`evidence:${canonical({id: e.id, url: e.url, excerpt: e.excerpt, signal: e.signal})}`))})),
    ...learnings.map((l) => ({at: l.at, leaf: keccak256(toHex(`learning:${canonical({id: l.id, findings: l.findings, reallocations: l.reallocations})}`))})),
  ];
  if (!records.length) return;
  // When a type reaches its batch limit, stop at its last timestamp so nothing is skipped by the next checkpoint.
  const limits = [receipts, evidence, learnings].filter((rows) => rows.length === MAX_RECORDS).map((rows) => rows[rows.length - 1].at!.getTime() - 1);
  const coveredUntil = new Date(Math.min(Math.max(...records.map((r) => r.at.getTime())), ...limits));
  const included = records.filter((r) => r.at.getTime() <= coveredUntil.getTime());
  if (!included.length) return;
  const leaves = [...new Set(included.map((r) => r.leaf))];
  const root = merkleRoot(leaves);
  const head = await publicClient().readContract({address: ledger, abi: ledgerAbi, functionName: "head", args: [workspace]}) as Hex;
  const txHash = await operatorConfirm(ledger, ledgerAbi, "commitCheckpoint", [workspace, root, leaves.length, head]);
  const number = Number(await publicClient().readContract({address: ledger, abi: ledgerAbi, functionName: "checkpointCount", args: [workspace]}));
  await db.insert(s.protocolCheckpoints).values({id: newId(), projectId, number, root, records: leaves.length, leaves, coveredUntil, txHash});
  const latest = new Map(learnings.filter((l) => l.at <= coveredUntil).map((l) => [l.missionId, l]));
  for (const [missionId, learning] of latest) {
    await operatorConfirm(ledger, ledgerAbi, "recordLearning", [workspace, protocolId("mission", missionId), keccak256(toHex(canonical(learning.findings))), learning.reallocations.length ? 1 : 0]);
  }
  log("operator", `Committed ${leaves.length} record(s) to GrowthLedger, checkpoint ${number}`);
}

async function recordOutcomes(db: DB, projectId: string, workspace: Address, ledger: Address, log: Log) {
  const rows = await db.select({experimentId: s.attribution.experimentId, id: s.conversionEvents.id, eventType: s.conversionEvents.eventType, visitorId: s.conversionEvents.visitorId, valueMicro: s.conversionEvents.valueMicro}).from(s.attribution).innerJoin(s.conversionEvents, eq(s.attribution.conversionEventId, s.conversionEvents.id)).where(and(eq(s.conversionEvents.projectId, projectId), sql`${s.conversionEvents.dataMode} = 'LIVE'`));
  const byExperiment = new Map<string, OutcomeEvent[]>();
  for (const row of rows) if (row.experimentId) byExperiment.set(row.experimentId, [...(byExperiment.get(row.experimentId) ?? []), row]);
  for (const [experimentId, events] of byExperiment) {
    const id = protocolId("experiment", experimentId);
    const current = await publicClient().readContract({address: ledger, abi: ledgerAbi, functionName: "outcomes", args: [workspace, id]}) as readonly bigint[];
    const onchain = {customers: current[0], activated: current[1], paying: current[2], revenue: current[3], refunded: current[4]};
    const next = aggregateOutcomes(events, onchain);
    if ((Object.keys(next) as (keyof OutcomeTotals)[]).every((key) => next[key] === onchain[key])) continue;
    await operatorConfirm(ledger, ledgerAbi, "recordOutcomes", [workspace, id, next, merkleRoot(events.map((e) => keccak256(toHex(`event:${e.id}`))))]);
    log("operator", `Recorded measured outcomes onchain for one experiment`);
  }
}

/** Budget moved by the learning loop is mirrored onchain. A refused move leaves the stricter onchain budget in force. */
async function syncExperimentBudgets(db: DB, projectId: string, workspace: Address, log: Log) {
  const rows = await db.select({id: s.experiments.id, budget: s.experiments.budgetMicro}).from(s.experiments).where(and(eq(s.experiments.projectId, projectId), inArray(s.experiments.status, ["proposed", "awaiting_approval", "running"])));
  const sources: {id: Hex; spare: bigint}[] = [], targets: {id: Hex; need: bigint}[] = [];
  for (const row of rows) {
    const id = protocolId("experiment", row.id);
    const onchain = await readWorkspace<readonly [Hex, bigint, bigint, boolean, Hex]>(workspace, "experiments", [id]);
    if (!onchain[3]) continue;
    const delta = BigInt(row.budget) - onchain[1];
    if (delta > 0n) targets.push({id, need: delta});
    if (delta < 0n) sources.push({id, spare: -delta});
  }
  for (const target of targets) for (const source of sources) {
    const amount = target.need < source.spare ? target.need : source.spare;
    if (amount <= 0n) continue;
    await operatorConfirm(workspace, workspaceAbi, "reallocate", [source.id, target.id, amount]).then(() => { target.need -= amount; source.spare -= amount; }).catch((error: Error) => log("operator", `Budget move stays offchain until an admin approves it: ${error.message}`));
  }
}

/** Runs after each operator cycle. Failures never block the cycle; the next one picks up where this stopped. */
export async function syncWorkspaceToChain(db: DB, projectId: string, log: Log = () => {}) {
  const protocol = protocolAddresses();
  if (!protocol || operatorProblem()) return;
  const [wallet] = await db.select().from(s.wallets).where(eq(s.wallets.projectId, projectId));
  if (wallet?.provider !== "growth_vault" || !wallet.address) return;
  const workspace = wallet.address as Address;
  const frozen = await readWorkspace<boolean>(workspace, "frozen");
  if (frozen !== wallet.frozen) await db.update(s.wallets).set({frozen}).where(eq(s.wallets.id, wallet.id));
  if (!await readWorkspace<boolean>(workspace, "hasRole", [operatorAccount().address, ROLE_OPERATOR])) {
    log("operator", "The workspace owner removed this agent, so onchain records are paused");
    return;
  }
  await syncExperimentBudgets(db, projectId, workspace, log);
  await recordOutcomes(db, projectId, workspace, protocol.ledger, log);
  await commitRecords(db, projectId, workspace, protocol.ledger, log);
}

export async function linkWorkspace(db: DB, v: {projectId: string; userId: string; address: string}) {
  const workspace = await verifyWorkspace(v.projectId, v.address);
  const {attachVaultWallet} = await import("./wallets");
  const frozen = await readWorkspace<boolean>(workspace, "frozen");
  const row = await attachVaultWallet(db, {projectId: v.projectId, address: workspace, frozen});
  await audit(db, {projectId: v.projectId, actorType: "user", actorId: v.userId, action: "wallet.link_contract", target: workspace});
  return row;
}

export interface ProtocolView {
  factory: Address; ledger: Address; operator: Address | null; ref: Hex; attribution: Hex | null; workspace: Address | null;
  policy: {autonomyEnabled: boolean; maxTransaction: string; dailySpend: string; hardCeiling: string; autonomousCategories: number; approvalCategories: number};
  policyInSync: boolean; owner: Address | null; frozen: boolean; operatorActive: boolean; checkpoints: number;
  /** budgetInSync: the published budget matches the current monthly budget. */
  mission: {id: Hex; name: string; budget: string; endsAt: string; goalHash: Hex; categories: number[]; budgets: string[]; published: boolean; budgetInSync: boolean} | null;
  /** Token balances held by the contract, in micro-units, and the part reserved for open payments. */
  funds: {token: "USDC" | "USD₮"; address: Address; balance: string; reserved: string}[];
}
export async function loadProtocolView(db: DB, project: {id: string}, wallet: {provider: string; address: string | null} | null, policyRow: Parameters<typeof onchainPolicy>[0] | null, mission: typeof s.missions.$inferSelect | null): Promise<ProtocolView | null> {
  const protocol = protocolAddresses();
  if (!protocol || !policyRow) return null;
  const code = process.env.CELO_ATTRIBUTION_CODE;
  const policy = onchainPolicy(policyRow);
  const workspace = wallet?.provider === "growth_vault" && wallet.address ? wallet.address as Address : null;
  const operator = operatorProblem() ? null : operatorAccount().address;
  let policyInSync = false, owner: Address | null = null, frozen = false, operatorActive = false, published = false, budgetInSync = false, checkpoints = 0;
  let funds: ProtocolView["funds"] = [];
  if (workspace) {
    const missionId = mission ? protocolId("mission", mission.id) : null;
    const tokens = [{token: "USDC" as const, address: CELO.usdc as Address}, {token: "USD₮" as const, address: USDT.address}];
    const [current, currentOwner, isFrozen, onchainMission, count, operatorRoles, held] = await Promise.all([
      readWorkspace<readonly [boolean, bigint, bigint, bigint, number, number]>(workspace, "policy"), readWorkspace<Address>(workspace, "owner"), readWorkspace<boolean>(workspace, "frozen"),
      missionId ? readWorkspace<readonly bigint[]>(workspace, "missions", [missionId]) : Promise.resolve(null),
      publicClient().readContract({address: protocol.ledger, abi: ledgerAbi, functionName: "checkpointCount", args: [workspace]}) as Promise<bigint>,
      operator ? readWorkspace<number>(workspace, "roles", [operator]) : Promise.resolve(0),
      Promise.all(tokens.map(async (t) => {
        const [balance, reserved] = await Promise.all([publicClient().readContract({address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [workspace]}), readWorkspace<bigint>(workspace, "reserved", [t.address])]);
        return {...t, balance: balance.toString(), reserved: reserved.toString()};
      })),
    ]);
    operatorActive = (operatorRoles & ROLE_OPERATOR) !== 0;
    policyInSync = current[0] === policy.autonomyEnabled && current[1] === policy.maxTransaction && current[2] === policy.dailySpend && current[3] === policy.hardCeiling && current[4] === policy.autonomousCategories && current[5] === policy.approvalCategories;
    owner = currentOwner; frozen = isFrozen; published = !!onchainMission && onchainMission[3] !== 0n; budgetInSync = published && !!mission && onchainMission![0] === BigInt(mission.budgetMicro); checkpoints = Number(count); funds = held;
  }
  const budgets = mission ? await db.select().from(s.missionBudgets).where(eq(s.missionBudgets.missionId, mission.id)) : [];
  const allocated = budgets.filter((b) => CATEGORIES.includes(b.category as (typeof CATEGORIES)[number]));
  return {
    ...protocol, operator, ref: workspaceRef(project.id), attribution: code && /^[a-z0-9_]{1,32}$/.test(code) ? toDataSuffix(code) as Hex : null, workspace,
    policy: {autonomyEnabled: policy.autonomyEnabled, maxTransaction: policy.maxTransaction.toString(), dailySpend: policy.dailySpend.toString(), hardCeiling: policy.hardCeiling.toString(), autonomousCategories: policy.autonomousCategories, approvalCategories: policy.approvalCategories},
    policyInSync, owner, frozen, operatorActive, checkpoints, funds,
    // Onchain, every kind of spend may use the whole month, and a month stays open one extra period
    // so tests that started in it can pay their second half; new tests always open in the current month.
    mission: mission ? {id: protocolId("mission", mission.id), name: mission.name, budget: String(mission.budgetMicro), endsAt: String(Math.floor((mission.endsAt.getTime() + BUDGET_PERIOD_MS) / 1000)), goalHash: keccak256(toHex(canonical({name: mission.name, goal: mission.goalDescription, event: mission.goalEvent, target: mission.goalTarget}))), categories: allocated.map((b) => CATEGORIES.indexOf(b.category as (typeof CATEGORIES)[number])), budgets: allocated.map(() => String(mission.budgetMicro)), published, budgetInSync} : null,
  };
}
