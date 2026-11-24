import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { HttpRequestError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DB } from "@/server/db/client";
import { companyIntel, narrativePulse, type Reader, type SourceResult } from "../services/signals-api/research";
import { evaluateReadiness, parseRoles, type ChainFacts } from "@/server/integrations/celo/readiness";
import { CELO, parseAgentId } from "@/server/integrations/celo/config";
import { safeErrorMessage } from "@/server/security/safe-error";
import { canTransition, SPENT_STATES } from "@/server/domain/agent/ledger";
import { pay, PaymentOutcomeUnknownError, type X402Quote } from "@/server/integrations/celo/x402";

process.env.PGLITE_DIR = "memory://";
const external = vi.hoisted(() => ({ response: null as null | (() => unknown), payError: null as Error | null }));
vi.mock("@/server/security/public-http", async (original) => ({
  ...await original<typeof import("@/server/security/public-http")>(),
  getPublicText: async () => external.response?.(),
}));
vi.mock("@/server/integrations/celo/client", async (original) => ({ ...await original<typeof import("@/server/integrations/celo/client")>(), assertCeloMainnet: async () => {} }));
vi.mock("@/server/integrations/email", () => ({ sendEmail: vi.fn(async () => undefined), emailConfigured: () => false }));
vi.mock("@/server/domain/intel/analyze", () => ({ analyzeProject: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/celo/signer", () => {
  const signer = () => ({ address: "0x1111111111111111111111111111111111111111", kind: "test", signTypedData: async () => "0x" });
  return { signerFor: signer, researchSignerFor: signer };
});
vi.mock("@/server/integrations/celo/wallets", () => ({ getWallet: async () => ({ id: "wallet", frozen: false }), walletIsLive: () => true }));
vi.mock("@/server/domain/agent/ledger", async (original) => {
  const real = await original<typeof import("@/server/domain/agent/ledger")>();
  return { ...real, claimExecution: async (db: DB, txId: string) => ({ claimed: await real.transition(db, txId, "EXECUTING"), state: "EXECUTING", message: "claimed" }) };
});

const NOW = Date.parse("2026-11-23T12:00:00Z");
const RECENT = "2026-11-20T12:00:00Z";
const ok = <T>(data: T): SourceResult<T> => ({ state: "ok", data });
const reader = (routes: { org?: SourceResult<unknown>; repos?: SourceResult<unknown>; hn?: SourceResult<unknown> }): Reader =>
  (async (url: string) => url.includes("/repos") ? routes.repos ?? ok([]) : url.includes("api.github.com") ? routes.org ?? { state: "not_found" } : routes.hn ?? ok({ hits: [] })) as Reader;
const launch = { objectID: "1", title: "Show HN: Acme launch", created_at: RECENT };

describe("paid research never reports an outage as data", () => {
  it("returns 503, which x402 does not settle, when every source fails", async () => {
    const result = await companyIntel({ company: "Acme" }, reader({ org: { state: "failed" }, hn: { state: "failed" } }), NOW);
    expect(result.status).toBe(503);
    expect(result.body.signals).toBeUndefined();
  });
  it("returns 503 when one source fails and the other found nothing", async () => {
    expect((await companyIntel({ company: "Acme" }, reader({ org: { state: "failed" } }), NOW)).status).toBe(503);
  });
  it("marks partial results that still contain evidence", async () => {
    const result = await companyIntel({ company: "Acme" }, reader({ org: { state: "failed" }, hn: ok({ hits: [launch] }) }), NOW);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ complete: false, unavailableSources: ["api.github.com"], sources: ["hn.algolia.com"] });
  });
  it("treats a missing GitHub organization as an answered source", async () => {
    const result = await companyIntel({ company: "Acme" }, reader({}), NOW);
    expect(result).toMatchObject({ status: 200, body: { complete: true, signals: [], unavailableSources: [] } });
  });
  it("treats malformed upstream data as unavailable", async () => {
    expect((await companyIntel({ company: "Acme" }, reader({ hn: ok({ hits: "bad" }) }), NOW)).status).toBe(503);
  });
  it("rejects repeated, oversized and invalid parameters before research", async () => {
    const read = vi.fn() as unknown as Reader;
    for (const query of [{ company: ["a", "b"] }, { company: "x".repeat(121) }, { company: "Acme", github: "../secrets" }]) expect((await companyIntel(query, read, NOW)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps failed narrative weeks null instead of counting zero stories", async () => {
    let calls = 0;
    const read = (async () => (++calls === 2 ? { state: "failed" } : ok({ nbHits: 4 }))) as Reader;
    const result = await narrativePulse({ term: "stablecoins" }, read, NOW);
    expect(result.body.complete).toBe(false);
    expect((result.body.weeks as { stories: number | null }[]).map((week) => week.stories)).toEqual([4, null, 4, 4]);
  });
  it("returns 503 when no narrative week could be read", async () => {
    expect((await narrativePulse({ term: "stablecoins" }, (async () => ({ state: "failed" })) as Reader, NOW)).status).toBe(503);
  });
});

const agent = "0x1111111111111111111111111111111111111111";
const readyEnv = { APP_URL: "https://celo.growtendril.xyz", DATABASE_URL: "postgres://user:pass@db.example.test/app", SESSION_SECRET: "s".repeat(32), ENCRYPTION_KEY: "a".repeat(64), CELO_AGENT_ID: "42", SELF_AGENT_ENABLED: "1", CELO_RESEARCH_URLS: "https://signals.example.test/v1/company-intel", SIGNALS_SELLER_ADDRESS: "0x2222222222222222222222222222222222222222", X402_API_KEY: "key" };
const readyChain: ChainFacts = { rpcChainId: CELO.chainId, custody: "celo", agentAddress: agent, nativeGasWei: 1n, usdcMicro: 1n, identityOwner: agent, identityUri: "https://celo.growtendril.xyz/.well-known/agent-registration.json", selfVerified: true };
const failing = (env: Record<string, string | undefined>, chain: ChainFacts, roles = parseRoles([])) => evaluateReadiness(env, chain, roles).filter((check) => !check.ok).map((check) => `${check.role}:${check.id}`);

describe("doctor readiness", () => {
  it("passes only when every role's requirements are met", () => expect(failing(readyEnv, readyChain)).toEqual([]));
  it("fails on missing proof, funding and ownership", () => {
    expect(failing(readyEnv, { ...readyChain, selfVerified: false })).toEqual(["buyer:self_verified"]);
    expect(failing(readyEnv, { ...readyChain, nativeGasWei: 0n })).toEqual(["buyer:gas"]);
    expect(failing(readyEnv, { ...readyChain, identityOwner: "0x3333333333333333333333333333333333333333" })).toEqual(["buyer:erc8004_owner"]);
    expect(failing(readyEnv, { ...readyChain, identityUri: "https://other.example/agent.json" })).toEqual(["buyer:erc8004_uri"]);
  });
  it("does not require buyer secrets on a seller-only service", () => {
    expect(failing({ SIGNALS_SELLER_ADDRESS: readyEnv.SIGNALS_SELLER_ADDRESS, X402_API_KEY: "key" }, { ...readyChain, custody: null, agentAddress: null }, parseRoles(["--role=seller"]))).toEqual([]);
  });
  it("rejects unknown roles", () => expect(() => parseRoles(["--role=admin"])).toThrow(/Unknown role/));
  it("accepts only canonical safe agent IDs", () => {
    expect(parseAgentId("42")).toBe(42);
    for (const value of ["", "042", "1e3", "-1", "9007199254740993", undefined]) expect(parseAgentId(value)).toBeNull();
  });
});

describe("persisted errors", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("hides an opaque private RPC token, including inside viem errors", () => {
    const url = "https://celo-provider.example/v1/FAKE_PRIVATE_RPC_TOKEN";
    vi.stubEnv("CELO_MAINNET_RPC", url);
    expect(safeErrorMessage(new Error(`HTTP request failed. URL: ${url}`))).not.toContain("FAKE_PRIVATE");
    expect(safeErrorMessage(new HttpRequestError({ url }))).not.toContain("FAKE_PRIVATE");
  });
  it("keeps ordinary business messages readable", () => expect(safeErrorMessage(new Error("Budget is full"))).toBe("Budget is full"));
});

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const signer = { address: payer.address, kind: "test", signTypedData: (p: unknown) => payer.signTypedData(p as Parameters<typeof payer.signTypedData>[0]) } as unknown as Parameters<typeof pay>[1];
const seller = "0x2222222222222222222222222222222222222222";
const q: X402Quote = { url: "https://research.example.com/v1/company-intel?company=Acme", method: "GET", x402Version: 2, resource: { url: "https://research.example.com/" }, amountMicro: 10_000, payTo: seller, requirement: { scheme: "exact", network: CELO.caip2, asset: CELO.usdc, amount: "10000", payTo: seller, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } } };
const reply = (status: number, headers: Record<string, string> = {}, text = "{}") => () => ({ status, ok: status >= 200 && status < 300, headers, text });

describe("signed x402 payments with no proof of outcome", () => {
  afterEach(() => { external.response = null; });
  it.each([
    ["timeout", () => { throw new Error("Timed out"); }],
    ["gateway timeout", reply(504)],
    ["bad gateway", reply(502)],
    ["200 without a receipt", reply(200)],
    ["200 with a malformed receipt", reply(200, { "payment-response": Buffer.from("not-json").toString("base64") })],
  ])("treats %s as unknown", async (_name, response) => {
    external.response = response;
    await expect(pay(q, signer, { maxAmountMicro: 10_000 })).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
  });
  it.each([402, 400, 403, 503])("treats a definitive %i rejection as failed", async (status) => {
    external.response = reply(status, {}, '{"error":"rejected"}');
    const error = await pay(q, signer, { maxAmountMicro: 10_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PaymentOutcomeUnknownError);
  });
  it("keeps exception funds committed", () => {
    expect(canTransition("EXECUTING", "EXCEPTION")).toBe(true);
    expect(SPENT_STATES).toContain("EXCEPTION");
  });
});

describe("ledger after an unconfirmed research payment", () => {
  let db: DB;
  let schema: typeof import("@/server/db/schema");
  beforeAll(async () => {
    const client = await import("@/server/db/client");
    db = await client.getDb(); schema = client.schema;
    await db.insert(schema.users).values({ id: "u", email: "owner@example.test", name: "Owner", passwordHash: "x" });
    await db.insert(schema.projects).values({ id: "p", ownerId: "u", name: "P", webhookSecret: "x" });
    await db.insert(schema.companies).values({ id: "c", projectId: "p", name: "Acme", dataMode: "LIVE" });
    await db.insert(schema.vendors).values({ id: "v", name: "Signals", source: "manual" });
    await db.insert(schema.services).values({ id: "svc", vendorId: "v", resourceUrl: q.url, description: "Research" });
  });
  it("records an exception, keeps the spend committed, and stores no purchased evidence", async () => {
    const { recordDecision } = await import("@/server/domain/agent/decisions");
    const { createTransaction, transition } = await import("@/server/domain/agent/ledger");
    const { executePurchase } = await import("@/server/domain/agent/purchase");
    const decision = await recordDecision(db, { projectId: "p", agent: "operator", kind: "purchase_service", action: {}, rationale: "test", status: "approved", dataMode: "LIVE" });
    const { tx } = await createTransaction(db, { projectId: "p", decisionId: decision.id, kind: "x402_purchase", rail: "celo_x402", budgetCategory: "research", amountMicro: 10_000, chain: CELO.appKitChain, recipient: seller, idempotencyKey: "unknown-outcome", dataMode: "LIVE" });
    await transition(db, tx.id, "AUTHORIZED");
    external.response = () => { throw new Error("socket hang up"); };
    const outcome = await executePurchase(db, { txId: tx.id, decisionId: decision.id, projectId: "p", companyId: "c", url: q.url, liveQuote: { kind: "quote", quote: q }, priceMicro: 10_000, before: 0.4, serviceId: "svc", purpose: "test" });
    expect(outcome).toMatchObject({ bought: false, state: "EXCEPTION", settlementId: null });
    const [saved] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx.id));
    expect(saved.state).toBe("EXCEPTION");
    const exceptions = await db.select().from(schema.ledgerExceptions).where(eq(schema.ledgerExceptions.transactionId, tx.id));
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ kind: "payout_unverified", status: "open", amountMicro: 10_000 });
    expect(await db.select().from(schema.evidence).where(eq(schema.evidence.projectId, "p"))).toHaveLength(0);
  });
});
