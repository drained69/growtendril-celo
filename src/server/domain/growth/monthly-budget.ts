import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { audit } from "@/server/db/helpers";
import { newId } from "@/server/lib/ids";
import { microToDecimal } from "@/lib/money";
import { deriveLimits, nextPeriod, RESEARCH_TYPES, SPEND_TYPES, type BudgetChoice } from "@/lib/budget";
import { missionSpend } from "@/server/domain/agent/ledger";
import { policyValues } from "@/server/domain/workspace/setup";

/**
 * The monthly growth budget. A goal's budget runs for 30 days; when the period ends the next
 * month starts with the same budget and goal, and unspent money does not roll over.
 *
 * The roll happens lazily, wherever the current goal is loaded. Tests that already paid
 * something (or wait for a decision) stay in the month they started in, marked "closing", so
 * the creator can still be paid the second half inside that month's budget. Drafts that never
 * attempted a payment move to the new month.
 */

const LIVE = ["proposed", "awaiting_approval", "running"];
type Mission = typeof s.missions.$inferSelect;

/** The active goal for this workspace, after starting a new month if the last one has ended. */
export async function currentMonth(db: DB, projectId: string, now: Date = new Date()): Promise<Mission | null> {
  const [active] = await db.select().from(s.missions).where(and(eq(s.missions.projectId, projectId), eq(s.missions.status, "active")));
  if (!active) return null;
  if (active.endsAt > now) return active;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`financial:${projectId}`}))`);
    const work = tx as unknown as DB;
    const [m] = await work.select().from(s.missions).where(and(eq(s.missions.id, active.id), eq(s.missions.status, "active")));
    // Another request rolled it while we waited for the lock.
    if (!m) return (await work.select().from(s.missions).where(and(eq(s.missions.projectId, projectId), eq(s.missions.status, "active"))))[0] ?? null;
    if (m.endsAt > now) return m;
    const period = nextPeriod(m.endsAt, now);
    const nextId = newId();
    await work.insert(s.missions).values({
      id: nextId, projectId, template: m.template, name: m.name, goalDescription: m.goalDescription, goalEvent: m.goalEvent, goalTarget: m.goalTarget,
      budgetMicro: m.budgetMicro, startsAt: period.startsAt, endsAt: period.endsAt, status: "active", dataMode: m.dataMode,
    });
    const budgets = await work.select().from(s.missionBudgets).where(eq(s.missionBudgets.missionId, m.id));
    const rows = budgets.length ? budgets.map((b) => ({ category: b.category, allocatedMicro: Math.min(b.allocatedMicro, m.budgetMicro) })) : SPEND_TYPES.map((category) => ({ category, allocatedMicro: m.budgetMicro }));
    await work.insert(s.missionBudgets).values(rows.map((r) => ({ id: newId(), missionId: nextId, ...r })));
    // Drafts with no payment attempt start fresh in the new month; anything already paying finishes where it started.
    const open = await work.select({ id: s.experiments.id, channel: s.experiments.channel }).from(s.experiments).where(and(eq(s.experiments.missionId, m.id), inArray(s.experiments.status, LIVE)));
    let staying = 0;
    for (const x of open) {
      const [attempt] = await work.select({ id: s.transactions.id }).from(s.transactions).where(eq(s.transactions.experimentId, x.id)).limit(1);
      if (attempt || x.channel === "creator_program") staying++;
      else await work.update(s.experiments).set({ missionId: nextId, updatedAt: new Date() }).where(eq(s.experiments.id, x.id));
    }
    await work.update(s.missions).set({ status: staying ? "closing" : "completed" }).where(eq(s.missions.id, m.id));
    await audit(work, { projectId, actorType: "system", action: "budget.new_month", target: nextId, data: { previous: m.id, budgetMicro: m.budgetMicro, startsAt: period.startsAt.toISOString(), endsAt: period.endsAt.toISOString(), stillPaying: staying } });
    await closeFinishedMonths(work, projectId);
    const [next] = await work.select().from(s.missions).where(eq(s.missions.id, nextId));
    return next;
  });
}

/** A past month stays open only while one of its tests can still pay; then it is completed. */
export async function closeFinishedMonths(db: DB, projectId: string): Promise<number> {
  const closing = await db.select({ id: s.missions.id }).from(s.missions).where(and(eq(s.missions.projectId, projectId), eq(s.missions.status, "closing")));
  let closed = 0;
  for (const m of closing) {
    const [live] = await db.select({ id: s.experiments.id }).from(s.experiments).where(and(eq(s.experiments.missionId, m.id), inArray(s.experiments.status, LIVE))).limit(1);
    if (live) continue;
    await db.update(s.missions).set({ status: "completed" }).where(and(eq(s.missions.id, m.id), eq(s.missions.status, "closing")));
    closed++;
  }
  return closed;
}

/** "This month: $X of $Y used · resets on <date>" — committed spend this month against its budget. */
export async function monthUsage(db: DB, mission: Mission) {
  const { spent, pending } = await missionSpend(db, mission.id);
  return { usedMicro: spent + pending, budgetMicro: mission.budgetMicro, leftMicro: Math.max(0, mission.budgetMicro - spent - pending), resetsAt: mission.endsAt };
}

/** What the owner chose, read back from the goal and the policy. */
export async function budgetChoice(db: DB, projectId: string, mission: Mission | null): Promise<{ monthlyMicro: number; largestPaymentMicro: number; researchMonthlyMicro: number; dailySpendMicro: number } | null> {
  const [policy] = await db.select().from(s.policies).where(eq(s.policies.projectId, projectId));
  if (!policy) return null;
  const [research] = mission && policy.autonomyEnabled ? await db.select().from(s.missionBudgets).where(and(eq(s.missionBudgets.missionId, mission.id), eq(s.missionBudgets.category, "research"))) : [];
  const ceiling = policy.customPaymentCeilingEnabled ? policy.hardCeilingMicro : Math.min(policy.hardCeilingMicro, 10_000_000);
  const researchMonthlyMicro = policy.autonomyEnabled ? (research?.allocatedMicro ?? mission?.budgetMicro ?? 0) : 0;
  return { monthlyMicro: mission?.budgetMicro ?? 0, largestPaymentMicro: ceiling, researchMonthlyMicro, dailySpendMicro: policy.dailySpendMicro };
}

/**
 * Saves the monthly budget, the largest single payment and the research allowance, and derives
 * everything else: the hard ceiling and daily limit, and a budget for every kind of spend equal
 * to the whole month so none of them blocks. The policy engine and approvals are unchanged.
 */
export async function setGrowthBudget(db: DB, v: { projectId: string; actorId: string } & BudgetChoice & { dailySpendMicro?: number }) {
  if (!Number.isSafeInteger(v.monthlyMicro) || v.monthlyMicro <= 0) throw new Error("Enter a monthly budget above $0");
  if (v.largestPaymentMicro !== undefined && (!Number.isSafeInteger(v.largestPaymentMicro) || v.largestPaymentMicro <= 0)) throw new Error("Enter a largest single payment above $0");
  if (v.researchMonthlyMicro !== undefined && (!Number.isSafeInteger(v.researchMonthlyMicro) || v.researchMonthlyMicro < 0)) throw new Error("Enter a research amount of $0 or more");
  const limits = deriveLimits(v);
  if (limits.hardCeilingMicro > limits.monthlyMicro) throw new Error("The largest single payment can't be more than the monthly budget");
  const daily = v.dailySpendMicro ?? limits.dailySpendMicro;
  if (!Number.isSafeInteger(daily) || daily < 0) throw new Error("Enter a daily limit of $0 or more");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`financial:${v.projectId}`}))`);
    const work = tx as unknown as DB;
    const [mission] = await work.select().from(s.missions).where(and(eq(s.missions.projectId, v.projectId), eq(s.missions.status, "active")));
    if (!mission) throw new Error("Set a goal first. The monthly budget belongs to your goal.");
    const [cur] = await work.select().from(s.policies).where(eq(s.policies.projectId, v.projectId)).for("update");
    if (!cur) throw new Error("Finish workspace setup before changing the budget");
    const { spent, pending } = await missionSpend(work, mission.id);
    if (limits.monthlyMicro < spent + pending) throw new Error(`This month has already used ${microToDecimal(spent + pending)} USDC. Choose a monthly budget of at least that much.`);
    await work.update(s.missions).set({ budgetMicro: limits.monthlyMicro }).where(eq(s.missions.id, mission.id));
    for (const category of SPEND_TYPES) {
      const allocatedMicro = limits.typeBudgets[category];
      const [row] = await work.select({ id: s.missionBudgets.id }).from(s.missionBudgets).where(and(eq(s.missionBudgets.missionId, mission.id), eq(s.missionBudgets.category, category)));
      if (row) await work.update(s.missionBudgets).set({ allocatedMicro, updatedAt: new Date() }).where(eq(s.missionBudgets.id, row.id));
      else await work.insert(s.missionBudgets).values({ id: newId(), missionId: mission.id, category, allocatedMicro });
    }
    const values = policyValues({ dailySpend: microToDecimal(daily), hardCeiling: microToDecimal(limits.hardCeilingMicro), autonomousLimit: microToDecimal(limits.autonomousLimitMicro) });
    await work.update(s.policies).set({ ...values, version: cur.version + 1, updatedAt: new Date() }).where(eq(s.policies.projectId, v.projectId));
    await audit(work, { projectId: v.projectId, actorType: "user", actorId: v.actorId, action: "budget.update", target: mission.id, data: { monthlyMicro: limits.monthlyMicro, largestPaymentMicro: limits.hardCeilingMicro, dailySpendMicro: daily, researchMonthlyMicro: limits.researchMonthlyMicro, researchTypes: [...RESEARCH_TYPES] } });
    return { limits: { ...limits, dailySpendMicro: daily }, missionId: mission.id, version: cur.version + 1 };
  });
}
