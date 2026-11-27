import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";

process.env.PGLITE_DIR = "memory://";

// No Circle in tests: the wallet "can sign", and App Kit is a controlled provider stub.
const provider = vi.hoisted(() => ({ reachable: false, sends: [] as { chain: string; to: string; amount: string }[] }));
vi.mock("@/server/integrations/celo/signer", () => ({ signerFor: () => ({ kind: "test" }) }));
vi.mock("@/server/integrations/celo/appkit", () => ({
  appKitSend: async (_wallet: unknown, payment: { chain: string; to: string; amount: string }) => {
    if (!provider.reachable) throw new Error("Circle unreachable in tests");
    provider.sends.push(payment);
    return { state: "pending", txHash: `0x${provider.sends.length.toString(16).padStart(64, "0")}`, explorerUrl: null, steps: [] };
  },
  appKitBridge: async () => {
    throw new Error("Circle unreachable in tests");
  },
}));

let db: DB;
let s: typeof import("@/server/db/schema");
let x: typeof import("@/server/domain/growth/experiments");
let exec: typeof import("@/server/domain/agent/execute");
let setup: typeof import("@/server/domain/workspace/setup");
let missionId: string;

const EXP = "exp-1";
const toMicro = (n: number) => Math.round(n * 1_000_000);

beforeAll(async () => {
  const client = await import("@/server/db/client");
  db = await client.getDb();
  s = client.schema;
  x = await import("@/server/domain/growth/experiments");
  exec = await import("@/server/domain/agent/execute");
  setup = await import("@/server/domain/workspace/setup");
  await db.insert(s.users).values({ id: "u1", email: "owner@example.test", name: "Owner", passwordHash: "x" });
  await db.insert(s.projects).values({ id: "p1", ownerId: "u1", name: "Crumb Club", webhookSecret: "secret" });
  await setup.startMission(db, { projectId: "p1", templateKey: "first_customers", goal: 25, days: 30, budget: "300" });
  await setup.activateWorkspace(db, { projectId: "p1", rules: { dailySpend: "50", hardCeiling: "10", autonomousLimit: "2" }, autopilot: "off" });
  [{ id: missionId }] = await db.select({ id: s.missions.id }).from(s.missions).where(eq(s.missions.projectId, "p1"));
  await db.insert(s.experiments).values({
    id: EXP,
    projectId: "p1",
    missionId,
    number: 1,
    title: "Own the conversation",
    hypothesis: "A definitive post reaches people already searching.",
    channel: "content",
    budgetCategory: "content",
    target: "10 visits",
    action: "Commission one post",
    budgetMicro: toMicro(20),
    successEvent: "purchase",
    successTarget: 2,
    stopMaxCpaMicro: toMicro(72),
    stopAfterSpendMicro: toMicro(10),
    timeframeDays: 10,
    status: "proposed",
    dataMode: "LIVE",
  });
});

const status = async () => (await db.select({ st: s.experiments.status }).from(s.experiments).where(eq(s.experiments.id, EXP)))[0].st;
const pendingApprovals = () => db.select().from(s.approvals).where(and(eq(s.approvals.projectId, "p1"), eq(s.approvals.status, "pending")));

describe("paying for an experiment", () => {
  it("asks who gets paid before a non-creator experiment can launch", async () => {
    await expect(x.launchExperiment(db, { projectId: "p1", experimentId: EXP })).rejects.toThrow(/who gets paid/);
  });

  it("pays each half in one payment, and refuses a half above the largest single payment instead of splitting it", async () => {
    const first = await x.nextInstallment(db, { id: EXP, budgetMicro: toMicro(20), stopAfterSpendMicro: toMicro(10) }, "first", toMicro(10));
    expect(first).toMatchObject({ amount: toMicro(10), installment: 1, dueMicro: toMicro(10) });
    await expect(x.nextInstallment(db, { id: EXP, budgetMicro: toMicro(30), stopAfterSpendMicro: toMicro(15) }, "first", toMicro(10))).rejects.toThrow(/largest single payment is 10(\.00)? USDC/);
  });

  it("is denied with a clear reason while no wallet can pay", async () => {
    await db.update(s.experiments).set({ recipientAddress: "0x000000000000000000000000000000000000bEEF", recipientLabel: "Writer" }).where(eq(s.experiments.id, EXP));
    const r = await x.launchExperiment(db, { projectId: "p1", experimentId: EXP });
    expect(r.verdict).toBe("DENY");
    expect(r.message).toMatch(/wallet/i);
    expect(r.message).not.toMatch(/autonomous limit/); // only the blocking rule, not approval-level noise
    expect(await status()).toBe("proposed");
  });

  it("sends payments to people for approval, and a failed payment reopens the experiment", async () => {
    await db.insert(s.wallets).values({ id: "w1", projectId: "p1", provider: "celo_eoa", address: "0x1111111111111111111111111111111111111111", circleWalletId: "cw", blockchain: "CELO", status: "ACTIVE", dataMode: "LIVE" });
    const r = await x.launchExperiment(db, { projectId: "p1", experimentId: EXP });
    expect(r.verdict).toBe("APPROVAL_REQUIRED");
    expect(await status()).toBe("awaiting_approval");
    const [ap] = await pendingApprovals();
    expect(ap.requestedMicro).toBe(toMicro(10));

    // While it waits, the first half is fully committed: no extra payment can be added to it.
    await expect(x.nextInstallment(db, { id: EXP, budgetMicro: toMicro(20), stopAfterSpendMicro: toMicro(10) }, "first", toMicro(10))).rejects.toThrow(/first payment is already made/);

    await exec.resolveApproval(db, { approvalId: ap.id, userId: "u1", resolution: "approve" });
    const [tx] = await db.select().from(s.transactions).where(eq(s.transactions.id, ap.transactionId!));
    expect(tx.state).toBe("FAILED");
    expect(await status()).toBe("proposed"); // not stuck in awaiting_approval
  });

  it("treats a retry after a failure as a new payment, and a rejection reopens instead of stopping", async () => {
    const r = await x.launchExperiment(db, { projectId: "p1", experimentId: EXP });
    expect(r.verdict).toBe("APPROVAL_REQUIRED");
    expect(r.message).not.toMatch(/duplicate/i);
    const [ap] = await pendingApprovals();
    await exec.resolveApproval(db, { approvalId: ap.id, userId: "u1", resolution: "reject", note: "not yet" });
    expect(await status()).toBe("proposed");
  });

  it("pays a test in at most two payments: half at launch and the rest once the work is live", async () => {
    const projectId = "real-budget";
    const experimentId = "real-budget-experiment";
    await db.insert(s.projects).values({ id: projectId, ownerId: "u1", name: "Customer campaign", webhookSecret: "secret" });
    const { missionId: realMissionId } = await setup.startMission(db, { projectId, templateKey: "first_customers", goal: 100, days: 30, budget: "1000" });
    await setup.activateWorkspace(db, { projectId, rules: { dailySpend: "200", hardCeiling: "50", autonomousLimit: "0" }, autopilot: "off" });
    await db.insert(s.wallets).values({ id: "real-budget-wallet", projectId, provider: "celo_eoa", address: "0x2222222222222222222222222222222222222222", circleWalletId: "real-cw", blockchain: "CELO", status: "ACTIVE", dataMode: "LIVE" });
    await db.insert(s.experiments).values({
      id: experimentId, projectId, missionId: realMissionId, number: 1, title: "Commission customer research", hypothesis: "A useful post reaches qualified buyers.",
      channel: "content", budgetCategory: "content", target: "10 purchases", action: "Commission a post", budgetMicro: toMicro(100), successEvent: "purchase", successTarget: 10,
      stopMaxCpaMicro: toMicro(20), stopAfterSpendMicro: toMicro(50), timeframeDays: 10, status: "proposed", dataMode: "LIVE",
      recipientAddress: "0x000000000000000000000000000000000000bEEF", recipientLabel: "Writer",
    });

    const propose = async (tranche: "first" | "second", expectedAmount: number) => {
      const result = await x.launchExperiment(db, { projectId, experimentId, tranche });
      expect(result.verdict).toBe("APPROVAL_REQUIRED");
      const [approval] = await db.select().from(s.approvals).where(eq(s.approvals.id, result.approvalId!));
      expect(approval.requestedMicro).toBe(toMicro(expectedAmount));
      return approval;
    };

    const first = await propose("first", 50);
    provider.reachable = true;
    try {
      const result = await exec.resolveApproval(db, { approvalId: first.id, userId: "u1", resolution: "approve" });
      expect(result.state).toBe("SUBMITTED");
      expect(provider.sends).toEqual([{ chain: "Celo", to: "0x000000000000000000000000000000000000bEEF", amount: "50" }]);
    } finally {
      provider.reachable = false;
    }
    await expect(x.launchExperiment(db, { projectId, experimentId, tranche: "second" })).rejects.toThrow(/when the work is live/);
    await x.recordDelivery(db, { projectId, experimentId, userId: "u1", url: "https://example.test/delivered-post" });
    await expect(x.launchExperiment(db, { projectId, experimentId })).rejects.toThrow(/first payment is already made/);

    await propose("second", 50);
    expect(await x.experimentCommitted(db, experimentId)).toMatchObject({ committedMicro: toMicro(100), attempts: 2 });
    await expect(x.launchExperiment(db, { projectId, experimentId, tranche: "second" })).rejects.toThrow(/whole budget is already paid or waiting/);
  });
});
