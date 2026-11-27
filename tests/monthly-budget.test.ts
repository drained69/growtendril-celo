import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { BUDGET_PERIOD_MS, DAILY_LIMIT_MULTIPLE, defaultLargestPaymentMicro, defaultTestBudgetMicro, deriveLimits, nextPeriod, paymentPlan, SPEND_TYPES } from "@/lib/budget";

process.env.PGLITE_DIR = "memory://";

const usdc = (n: number) => Math.round(n * 1_000_000);

describe("a monthly budget derives every other limit", () => {
  it("defaults the largest single payment to the smaller of a quarter of the budget and $50", () => {
    expect(defaultLargestPaymentMicro(usdc(100))).toBe(usdc(25));
    expect(defaultLargestPaymentMicro(usdc(1_000))).toBe(usdc(50));
    expect(defaultLargestPaymentMicro(usdc(10))).toBe(usdc(2.5));
    // Never below $1, and never more than the budget itself.
    expect(defaultLargestPaymentMicro(usdc(2))).toBe(usdc(1));
    expect(defaultLargestPaymentMicro(usdc(0.5))).toBe(usdc(0.5));
  });

  it("maps to the hard ceiling and daily limit, and gives every kind of spend the whole month", () => {
    const l = deriveLimits({ monthlyMicro: usdc(100) });
    expect(l).toMatchObject({ monthlyMicro: usdc(100), hardCeilingMicro: usdc(25), dailySpendMicro: usdc(25) * DAILY_LIMIT_MULTIPLE, autonomousLimitMicro: 0, researchMonthlyMicro: 0 });
    for (const t of SPEND_TYPES) expect(l.typeBudgets[t]).toBe(usdc(100));
  });

  it("lets research run on its own only up to its monthly allowance, one purchase at most the largest payment", () => {
    const l = deriveLimits({ monthlyMicro: usdc(100), largestPaymentMicro: usdc(10), researchMonthlyMicro: usdc(30) });
    expect(l).toMatchObject({ hardCeilingMicro: usdc(10), dailySpendMicro: usdc(30), autonomousLimitMicro: usdc(10), researchMonthlyMicro: usdc(30) });
    expect(l.typeBudgets.research).toBe(usdc(30));
    expect(l.typeBudgets.services).toBe(usdc(30));
    expect(l.typeBudgets.kol).toBe(usdc(100));
    // A research allowance can't be more than the month.
    expect(deriveLimits({ monthlyMicro: usdc(20), researchMonthlyMicro: usdc(500) }).researchMonthlyMicro).toBe(usdc(20));
  });
});

describe("a test is paid in one payment, or two", () => {
  it("pays in one payment when the budget fits the largest single payment", () => {
    expect(paymentPlan(usdc(20), usdc(25))).toEqual({ payments: 1, firstMicro: usdc(20), secondMicro: 0, fits: true, neededLargestMicro: usdc(20) });
  });
  it("pays half now and half when the work is live when it doesn't", () => {
    expect(paymentPlan(usdc(20), usdc(10))).toEqual({ payments: 2, firstMicro: usdc(10), secondMicro: usdc(10), fits: true, neededLargestMicro: usdc(10) });
    // An odd micro-unit goes to the first half; both halves still add up to the budget.
    const odd = paymentPlan(15, 10);
    expect(odd.firstMicro + odd.secondMicro).toBe(15);
    expect(odd.firstMicro).toBe(8);
  });
  it("never plans more than two payments: says up front what the largest payment would need to be", () => {
    expect(paymentPlan(usdc(75), usdc(10))).toMatchObject({ payments: 2, fits: false, neededLargestMicro: usdc(37.5) });
  });
  it("defaults a new test to $20, never more than two largest payments or what the month has left", () => {
    expect(defaultTestBudgetMicro({ leftThisMonthMicro: usdc(100), largestPaymentMicro: usdc(25) })).toBe(usdc(20));
    expect(defaultTestBudgetMicro({ leftThisMonthMicro: usdc(100), largestPaymentMicro: usdc(5) })).toBe(usdc(10));
    expect(defaultTestBudgetMicro({ leftThisMonthMicro: usdc(12), largestPaymentMicro: usdc(25) })).toBe(usdc(12));
    expect(defaultTestBudgetMicro({ leftThisMonthMicro: usdc(100), largestPaymentMicro: usdc(25), suggestedMicro: usdc(75) })).toBe(usdc(20));
  });
});

describe("budget periods", () => {
  it("starts the next month where the last one ended, skipping whole months nobody looked at", () => {
    const end = new Date("2026-11-01T00:00:00Z");
    expect(nextPeriod(end, new Date("2026-11-05T00:00:00Z"))).toEqual({ startsAt: end, endsAt: new Date(end.getTime() + BUDGET_PERIOD_MS) });
    const later = nextPeriod(end, new Date(end.getTime() + 2 * BUDGET_PERIOD_MS + 1000));
    expect(later.startsAt.getTime()).toBe(end.getTime() + 2 * BUDGET_PERIOD_MS);
    expect(later.endsAt.getTime()).toBe(end.getTime() + 3 * BUDGET_PERIOD_MS);
  });
});

describe("the monthly rollover", () => {
  let db: DB;
  let s: typeof import("@/server/db/schema");
  let mb: typeof import("@/server/domain/growth/monthly-budget");
  let setup: typeof import("@/server/domain/workspace/setup");
  let ledger: typeof import("@/server/domain/agent/ledger");
  let firstMonth: string;

  const exp = (id: string, number: number, missionId: string, status = "proposed") => db.insert(s.experiments).values({
    id, projectId: "mb", missionId, number, title: `Test ${number}`, hypothesis: "A post reaches people already searching.", channel: "content", budgetCategory: "content",
    target: "10 visits", action: "Commission one post", budgetMicro: usdc(20), successEvent: "purchase", successTarget: 2, stopMaxCpaMicro: usdc(50), stopAfterSpendMicro: usdc(10),
    timeframeDays: 10, status, dataMode: "LIVE",
  });

  beforeAll(async () => {
    const client = await import("@/server/db/client");
    db = await client.getDb();
    s = client.schema;
    mb = await import("@/server/domain/growth/monthly-budget");
    setup = await import("@/server/domain/workspace/setup");
    ledger = await import("@/server/domain/agent/ledger");
    await db.insert(s.users).values({ id: "mb-owner", email: "mb@example.test", name: "Owner", passwordHash: "x" });
    await db.insert(s.projects).values({ id: "mb", ownerId: "mb-owner", name: "Bakery", webhookSecret: "secret" });
    ({ missionId: firstMonth } = await setup.startMission(db, { projectId: "mb", templateKey: "first_customers", goal: 25, days: 30, budget: "100" }));
    await setup.activateWorkspace(db, { projectId: "mb", rules: mb.rulesForBudget({ monthlyMicro: usdc(100) }), autopilot: "off" });
  });

  it("saves the budget, the largest payment and research allowance, and derives the rest", async () => {
    const r = await mb.setGrowthBudget(db, { projectId: "mb", actorId: "mb-owner", monthlyMicro: usdc(80), researchMonthlyMicro: usdc(8) });
    expect(r.limits).toMatchObject({ hardCeilingMicro: usdc(20), dailySpendMicro: usdc(60), autonomousLimitMicro: usdc(8) });
    const [policy] = await db.select().from(s.policies).where(eq(s.policies.projectId, "mb"));
    expect(policy).toMatchObject({ hardCeilingMicro: usdc(20), dailySpendMicro: usdc(60), maxTransactionMicro: usdc(8), autonomyEnabled: true, customPaymentCeilingEnabled: true });
    const budgets = await db.select().from(s.missionBudgets).where(eq(s.missionBudgets.missionId, firstMonth));
    expect(budgets.find((b) => b.category === "research")!.allocatedMicro).toBe(usdc(8));
    expect(budgets.find((b) => b.category === "kol")!.allocatedMicro).toBe(usdc(80));
    expect(await mb.budgetChoice(db, "mb", (await db.select().from(s.missions).where(eq(s.missions.id, firstMonth)))[0])).toMatchObject({ monthlyMicro: usdc(80), largestPaymentMicro: usdc(20), researchMonthlyMicro: usdc(8) });
    await expect(mb.setGrowthBudget(db, { projectId: "mb", actorId: "mb-owner", monthlyMicro: usdc(10), largestPaymentMicro: usdc(20) })).rejects.toThrow(/can't be more than the monthly budget/);
  });

  it("keeps the current month while it runs", async () => {
    const m = await mb.currentMonth(db, "mb");
    expect(m?.id).toBe(firstMonth);
  });

  it("starts the next month with the same goal and budget; unspent money doesn't carry over", async () => {
    // A draft nobody paid, and a test that already paid its first half.
    await exp("mb-draft", 1, firstMonth);
    await exp("mb-running", 2, firstMonth, "running");
    await db.insert(s.agentDecisions).values({ id: "mb-d", projectId: "mb", number: 1, agent: "operator", kind: "send_payment", action: {}, rationale: "First half", status: "executed", dataMode: "LIVE" });
    await db.insert(s.transactions).values({ id: "mb-t", projectId: "mb", decisionId: "mb-d", missionId: firstMonth, experimentId: "mb-running", kind: "send", rail: "celo_usdc_send", chain: "Celo", amountMicro: usdc(10), budgetCategory: "content", idempotencyKey: "mb-t", state: "SETTLED", dataMode: "LIVE" });
    const [old] = await db.select().from(s.missions).where(eq(s.missions.id, firstMonth));
    const now = new Date(old.endsAt.getTime() + 60_000);
    const next = await mb.currentMonth(db, "mb", now);
    expect(next?.id).not.toBe(firstMonth);
    expect(next).toMatchObject({ status: "active", template: old.template, goalTarget: old.goalTarget, goalDescription: old.goalDescription, budgetMicro: old.budgetMicro });
    expect(next!.startsAt.getTime()).toBe(old.endsAt.getTime());
    expect(next!.endsAt.getTime()).toBe(old.endsAt.getTime() + BUDGET_PERIOD_MS);
    // Nothing spent in the new month yet: the full budget is available again.
    expect(await mb.monthUsage(db, next!)).toMatchObject({ usedMicro: 0, leftMicro: next!.budgetMicro });
    // The research allowance carries over; every other type still has the whole month.
    const budgets = await db.select().from(s.missionBudgets).where(eq(s.missionBudgets.missionId, next!.id));
    expect(budgets.find((b) => b.category === "research")!.allocatedMicro).toBe(usdc(8));
    expect(budgets.find((b) => b.category === "content")!.allocatedMicro).toBe(next!.budgetMicro);
    // The untouched draft moved; the paying test finishes in its own month, which stays open for it.
    const [draft] = await db.select().from(s.experiments).where(eq(s.experiments.id, "mb-draft"));
    const [running] = await db.select().from(s.experiments).where(eq(s.experiments.id, "mb-running"));
    expect(draft.missionId).toBe(next!.id);
    expect(running.missionId).toBe(firstMonth);
    expect((await db.select().from(s.missions).where(eq(s.missions.id, firstMonth)))[0].status).toBe("closing");
    // Rolling twice is a no-op.
    expect((await mb.currentMonth(db, "mb", now))?.id).toBe(next!.id);
    expect(await db.select().from(s.missions).where(and(eq(s.missions.projectId, "mb"), eq(s.missions.status, "active")))).toHaveLength(1);
  });

  it("lets a past month pay only the tests that started in it, then closes it", async () => {
    const forRunning = await ledger.loadPolicyState(db, { projectId: "mb", missionId: firstMonth, category: "content", experimentId: "mb-running" });
    expect(forRunning.missionActive).toBe(true);
    expect(forRunning.missionCommittedMicro).toBe(usdc(10));
    // Nothing new can be paid from last month.
    const withoutTest = await ledger.loadPolicyState(db, { projectId: "mb", missionId: firstMonth, category: "research" });
    expect(withoutTest.missionActive).toBe(false);
    await db.update(s.experiments).set({ status: "succeeded" }).where(eq(s.experiments.id, "mb-running"));
    expect(await mb.closeFinishedMonths(db, "mb")).toBe(1);
    expect((await db.select().from(s.missions).where(eq(s.missions.id, firstMonth)))[0].status).toBe("completed");
    expect((await ledger.loadPolicyState(db, { projectId: "mb", missionId: firstMonth, category: "content", experimentId: "mb-running" })).missionActive).toBe(false);
  });
});
