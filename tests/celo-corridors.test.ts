import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { pad, toHex, type Hex } from "viem";
import type { Request, Response } from "express";
import type { DB } from "@/server/db/client";
import { CELO } from "@/server/integrations/celo/config";
import { PAYOUT_TOKENS, TEXTILE_REACTOR, USDT } from "@/server/integrations/celo/corridors";
import { validateCorridorQuote } from "@/server/integrations/celo/textile";
import { sessionGrant } from "@/server/integrations/celo/altana";
import { deliveryMatches, swapMatches, tokenMoves } from "@/server/domain/agent/corridor-payout";
import { selfIdentityGate } from "../services/signals-api/identity";

process.env.PGLITE_DIR = "memory://";
const WALLET = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const MAKER = "0x3333333333333333333333333333333333333333";
const CNGN = PAYOUT_TOKENS.cNGN.address;
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log = (address: string, from: string, to: string, value: bigint) => ({address, topics: [TOPIC, pad(from as Hex), pad(to as Hex)], data: toHex(value, {size: 32})}) as never;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const chain = vi.hoisted(() => ({balance: 0n, allowance: 0n, receipts: new Map<string, unknown>(), writes: [] as {functionName: string; args: unknown[]}[], swaps: 0, n: 0, failDelivery: false, revertSwap: false, swapThrows: false}));
vi.mock("@/server/integrations/email", () => ({sendEmail: vi.fn(async () => undefined), emailConfigured: () => false}));
vi.mock("@/server/integrations/celo/client", async (original) => ({
  ...await original<typeof import("@/server/integrations/celo/client")>(),
  assertCeloMainnet: async () => {},
  agentAccount: () => ({signTypedData: async () => `0x${"11".repeat(65)}`}),
  publicClient: () => ({
    readContract: async ({functionName}: {functionName: string}) => functionName === "balanceOf" ? chain.balance : chain.allowance,
    waitForTransactionReceipt: async ({hash}: {hash: string}) => chain.receipts.get(hash),
    getTransactionReceipt: async ({hash}: {hash: string}) => chain.receipts.get(hash),
  }),
  agentWalletClient: () => ({
    writeContract: async ({address, functionName, args}: {address: string; functionName: string; args: [string, bigint]}) => {
      chain.writes.push({functionName, args});
      if (functionName === "transfer" && chain.failDelivery) throw new Error("nonce too low");
      const h = hash(++chain.n);
      chain.receipts.set(h, {status: "success", logs: functionName === "transfer" ? [log(address, WALLET, args[0], args[1])] : []});
      return h;
    },
    sendTransaction: async () => {
      chain.swaps++;
      if (chain.swapThrows) throw new Error("socket hang up");
      const h = hash(++chain.n);
      chain.receipts.set(h, chain.revertSwap ? {status: "reverted", logs: []} : {status: "success", logs: [log(USDT.address, WALLET, MAKER, 10_000_000n), log(CNGN, MAKER, WALLET, 15_000_000_000n)]});
      return h;
    },
  }),
}));

const firm = (over: Record<string, unknown> = {}, quote: Record<string, unknown> = {}, swap: Record<string, unknown> = {}) => ({
  rfqId: "rfq_1", claimToken: "rfqc_1", status: "quoted", ...over,
  quote: {sellAmount: "10000000", buyAmount: "15000000000", feeAmount: "1000", takerPays: "10000000", rateRay: "1", expiresAt: new Date(Date.now() + 30_000).toISOString(), reactor: TEXTILE_REACTOR, taker: WALLET, ...quote},
  transactions: {swap: {to: TEXTILE_REACTOR, data: "0xdeadbeef", value: "0", chainId: CELO.chainId, ...swap}},
});
const expected = {sellMicro: 10_000_000n, taker: WALLET as Hex};

describe("Textile FX quote validation", () => {
  it("accepts a quote bound to this wallet and amount", () => expect(validateCorridorQuote(firm(), expected).buyAmount).toBe(15_000_000_000n));
  it.each([
    ["an unknown settlement contract", firm({}, {reactor: MAKER})],
    ["a swap sent elsewhere", firm({}, {}, {to: MAKER})],
    ["another taker", firm({}, {taker: MAKER})],
    ["more than the approved amount", firm({}, {takerPays: "10000001"})],
    ["an expired quote", firm({}, {expiresAt: new Date(Date.now() - 1).toISOString()})],
    ["native value on the swap", firm({}, {}, {value: "1"})],
    ["another chain", firm({}, {}, {chainId: 56})],
    ["zero delivered", firm({}, {buyAmount: "0"})],
    ["no maker", {rfqId: "rfq_2", status: "no_quote", reason: "no_makers_online"}],
  ])("rejects %s", (_name, quote) => expect(() => validateCorridorQuote(quote, expected)).toThrow());
});

describe("onchain payout checks", () => {
  const swap = tokenMoves([log(USDT.address, WALLET, MAKER, 10_000_000n), log(CNGN, MAKER, WALLET, 15n)]);
  it("requires the quoted local amount within the approved spend", () => {
    expect(swapMatches(swap, {wallet: WALLET, tokenAddress: CNGN, buyAmount: 15n, maxSellMicro: 10_000_000n})).toBe(true);
    expect(swapMatches(swap, {wallet: WALLET, tokenAddress: CNGN, buyAmount: 16n, maxSellMicro: 10_000_000n})).toBe(false);
    expect(swapMatches(swap, {wallet: WALLET, tokenAddress: CNGN, buyAmount: 15n, maxSellMicro: 9_999_999n})).toBe(false);
  });
  it("requires exact delivery to only the approved recipient", () => {
    const e = {wallet: WALLET, recipient: CREATOR, tokenAddress: CNGN, buyAmount: 15n};
    expect(deliveryMatches(tokenMoves([log(CNGN, WALLET, CREATOR, 15n)]), e)).toBe(true);
    expect(deliveryMatches(tokenMoves([log(CNGN, WALLET, CREATOR, 14n)]), e)).toBe(false);
    expect(deliveryMatches(tokenMoves([log(CNGN, WALLET, CREATOR, 15n), log(CNGN, WALLET, MAKER, 1n)]), e)).toBe(false);
  });
});

describe("Altana session limits", () => {
  it("allows only named stablecoin functions without a corridor", () => {
    const grant = sessionGrant(25_000_000n, "week");
    expect(grant.calls).toEqual([{to: CELO.usdc, signature: "transfer(address,uint256)"}, {to: USDT.address, signature: "transfer(address,uint256)"}]);
    expect(grant.spend.every((s) => s.limit === "25000000" && s.period === "week")).toBe(true);
  });
  it("adds Textile and a capped local token only when enabled", () => {
    const grant = sessionGrant(25_000_000n, "day", {cNGN: 50_000_000_000n});
    expect(grant.calls).toContainEqual({to: TEXTILE_REACTOR});
    expect(grant.spend).toContainEqual({token: CNGN, limit: "50000000000", period: "day"});
    expect(grant.calls.some((c) => c.to === PAYOUT_TOKENS.wBRL.address)).toBe(false);
  });
  it("refuses an empty cap", () => expect(() => sessionGrant(0n, "day")).toThrow());
});

describe("Self per-person limit", () => {
  const verified = (address: string) => ({valid: true, agentAddress: address, agentKey: pad(address as Hex), agentId: 1n, nullifier: 77n, agentCount: 2n});
  const paid = (from: string) => Buffer.from(JSON.stringify({x402Version: 2, payload: {authorization: {from}}})).toString("base64");
  const call = async (gate: ReturnType<typeof selfIdentityGate>, payer: string) => {
    const headers: Record<string, string> = {"payment-signature": paid(payer), "x-self-agent-signature": "sig", "x-self-agent-timestamp": String(Date.now())};
    let status = 200; const next = vi.fn();
    const res = {status: (v: number) => {status = v; return res;}, json: vi.fn(), setHeader: vi.fn()} as unknown as Response;
    await gate({method: "GET", originalUrl: "/v1/company-intel?company=A", socket: {remoteAddress: "203.0.113.5"}, get: (k: string) => headers[k.toLowerCase()]} as unknown as Request, res, next);
    return {status, served: next.mock.calls.length === 1};
  };
  it("makes two agents from one person share a quota", async () => {
    let agent = WALLET;
    const gate = selfIdentityGate({verify: vi.fn(async () => verified(agent))} as never, {paidRequestsPerHumanPerDay: 2});
    expect((await call(gate, agent)).served).toBe(true);
    agent = CREATOR;
    expect((await call(gate, agent)).served).toBe(true);
    expect(await call(gate, agent)).toEqual({status: 429, served: false});
  });
});

describe("corridor payout ledger", () => {
  let db: DB; let s: typeof import("@/server/db/schema"); let number = 0;
  let pay: typeof import("@/server/domain/agent/corridor-payout");
  let ledger: typeof import("@/server/domain/agent/ledger");
  let wallet: typeof import("@/server/db/schema").wallets.$inferSelect;
  beforeAll(async () => {
    process.env.CELO_ATTRIBUTION_CODE = "celo_test1";
    const client = await import("@/server/db/client");
    db = await client.getDb(); s = client.schema;
    pay = await import("@/server/domain/agent/corridor-payout"); ledger = await import("@/server/domain/agent/ledger");
    await db.insert(s.users).values({id: "u", email: "owner@example.test", name: "Owner", passwordHash: "x"});
    await db.insert(s.projects).values({id: "p", ownerId: "u", name: "P", webhookSecret: "x"});
    [wallet] = await db.insert(s.wallets).values({id: "w", projectId: "p", provider: "celo_eoa", address: WALLET, blockchain: "CELO", status: "ACTIVE", dataMode: "LIVE"}).returning();
  });
  beforeEach(() => {
    Object.assign(chain, {balance: 10_000_000n, allowance: 0n, writes: [], swaps: 0, failDelivery: false, revertSwap: false, swapThrows: false}); chain.receipts.clear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({data: url.endsWith("/submit") ? {} : firm()}), {status: 200})));
  });
  afterEach(() => vi.unstubAllGlobals());
  const executing = async () => {
    const {recordDecision} = await import("@/server/domain/agent/decisions");
    const decision = await recordDecision(db, {projectId: "p", agent: "operator", kind: "send_payment", action: {}, rationale: "test", status: "approved", dataMode: "LIVE"});
    const {tx} = await ledger.createTransaction(db, {projectId: "p", walletId: "w", decisionId: decision.id, kind: "send", rail: "textile_corridor", budgetCategory: "kol", amountMicro: 10_000_000, chain: "Celo", recipient: CREATOR, payoutToken: "cNGN", idempotencyKey: `corridor-${++number}`, dataMode: "LIVE"});
    await ledger.transition(db, tx.id, "AUTHORIZED"); await ledger.transition(db, tx.id, "EXECUTING");
    return (await db.select().from(s.transactions).where(eq(s.transactions.id, tx.id)))[0];
  };
  const stateOf = async (id: string) => (await db.select().from(s.transactions).where(eq(s.transactions.id, id)))[0].state;

  it("approves exactly the quote, converts, delivers, and settles from Celo logs", async () => {
    const tx = await executing();
    expect((await pay.executeCorridorPayout(db, tx, wallet)).state).toBe("SETTLED");
    expect(chain.writes.map((w) => w.functionName)).toEqual(["approve", "transfer"]);
    expect(chain.writes[0].args).toEqual([TEXTILE_REACTOR, 10_000_000n]);
    expect(chain.writes[1].args).toEqual([CREATOR, 15_000_000_000n]);
    const [row] = await db.select().from(s.corridorPayouts).where(eq(s.corridorPayouts.transactionId, tx.id));
    expect(row).toMatchObject({status: "paid", token: "cNGN", buyAmount: "15000000000"});
  });
  it("moves nothing when the wallet lacks USD₮", async () => {
    chain.balance = 9_999_999n;
    await expect(pay.executeCorridorPayout(db, await executing(), wallet)).rejects.toThrow(/funded in USD₮/);
    expect(chain.swaps).toBe(0); expect(chain.writes).toHaveLength(0);
  });
  it("marks a reverted conversion failed and never delivers", async () => {
    chain.revertSwap = true;
    const tx = await executing();
    expect((await pay.executeCorridorPayout(db, tx, wallet)).state).toBe("FAILED");
    expect(chain.writes.some((w) => w.functionName === "transfer")).toBe(false);
  });
  it("escalates a failed delivery once, with the funds still accounted for", async () => {
    chain.failDelivery = true;
    const tx = await executing();
    expect((await pay.executeCorridorPayout(db, tx, wallet)).state).toBe("EXCEPTION");
    expect(await stateOf(tx.id)).toBe("EXCEPTION");
    expect(chain.writes.filter((w) => w.functionName === "transfer")).toHaveLength(1);
    expect(await db.select().from(s.ledgerExceptions).where(eq(s.ledgerExceptions.transactionId, tx.id))).toHaveLength(1);
  });
  it("treats a lost swap broadcast as an unknown outcome", async () => {
    chain.swapThrows = true;
    const {ChainOutcomeUnknownError} = await import("@/server/integrations/celo/altana");
    await expect(pay.executeCorridorPayout(db, await executing(), wallet)).rejects.toBeInstanceOf(ChainOutcomeUnknownError);
  });
});
