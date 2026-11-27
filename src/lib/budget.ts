/**
 * The growth budget a small team sets: one monthly number, the largest single payment, and
 * whether GrowTendril may buy research on its own. Everything else is derived from these.
 * Pure and client-safe, so forms can preview the derived limits as the owner types.
 */

const MICRO = 1_000_000;
const toMicroUsdc = (usdc: number) => Math.round(usdc * MICRO);

/** A growth budget runs for 30 days, then starts again with the same budget and goal. */
export const BUDGET_PERIOD_DAYS = 30;
export const BUDGET_PERIOD_MS = BUDGET_PERIOD_DAYS * 24 * 60 * 60 * 1000;
export const DEFAULT_MONTHLY_BUDGET_USDC = 100;
/** The default largest single payment is the smaller of a quarter of the budget and this. */
export const DEFAULT_MAX_SINGLE_PAYMENT_USDC = 50;
/** What one test needs by default. Never more than the month has left. */
export const DEFAULT_TEST_BUDGET_USDC = 20;
/** The daily limit is set from the largest single payment; owners see it only under Advanced. */
export const DAILY_LIMIT_MULTIPLE = 3;
/** Kinds of spend. Each one gets the whole monthly budget so none of them ever blocks a payment. */
export const SPEND_TYPES = ["research", "services", "kol", "bounty", "content", "community"] as const;
/** The research and data purchases GrowTendril may make on its own when the owner allows it. */
export const RESEARCH_TYPES = ["research", "services"] as const;

/** The largest single payment for a monthly budget: a quarter of it, at most $50, at least $1. */
export function defaultLargestPaymentMicro(monthlyMicro: number): number {
  const quarter = Math.floor(Math.max(0, monthlyMicro) / 4 / 10_000) * 10_000;
  return Math.min(toMicroUsdc(DEFAULT_MAX_SINGLE_PAYMENT_USDC), Math.max(toMicroUsdc(1), quarter));
}

export interface BudgetChoice {
  monthlyMicro: number;
  /** Omitted: the default for this budget. */
  largestPaymentMicro?: number;
  /** How much research GrowTendril may buy on its own each month. 0 = it always asks. */
  researchMonthlyMicro?: number;
}

export interface DerivedLimits {
  monthlyMicro: number;
  /** The policy's hard ceiling: no single payment can be larger, approval or not. */
  hardCeilingMicro: number;
  dailySpendMicro: number;
  /** The policy's autonomous per-payment limit (max transaction). 0 when research isn't allowed. */
  autonomousLimitMicro: number;
  researchMonthlyMicro: number;
  /** Per spend type. Research and services carry the "on its own" monthly cap when it's on. */
  typeBudgets: Record<(typeof SPEND_TYPES)[number], number>;
}

export function deriveLimits(c: BudgetChoice): DerivedLimits {
  const monthly = Math.max(0, Math.floor(c.monthlyMicro));
  const largest = c.largestPaymentMicro && c.largestPaymentMicro > 0 ? Math.floor(c.largestPaymentMicro) : defaultLargestPaymentMicro(monthly);
  const research = Math.min(Math.max(0, Math.floor(c.researchMonthlyMicro ?? 0)), monthly);
  const typeBudgets = Object.fromEntries(SPEND_TYPES.map((t) => [t, (RESEARCH_TYPES as readonly string[]).includes(t) && research > 0 ? research : monthly])) as DerivedLimits["typeBudgets"];
  return {
    monthlyMicro: monthly,
    hardCeilingMicro: largest,
    dailySpendMicro: largest * DAILY_LIMIT_MULTIPLE,
    autonomousLimitMicro: research > 0 ? Math.min(largest, research) : 0,
    researchMonthlyMicro: research,
    typeBudgets,
  };
}

export interface PaymentPlan {
  /** 1: paid in full at launch. 2: half now, half when the work is live. */
  payments: 1 | 2;
  firstMicro: number;
  secondMicro: number;
  /** False when even two payments would be above the largest single payment. */
  fits: boolean;
  /** The largest single payment this test would need to fit in two payments. */
  neededLargestMicro: number;
}

/** How a test's budget is paid: once if it fits in one payment, otherwise half now and half when the work is live. */
export function paymentPlan(testBudgetMicro: number, largestPaymentMicro: number): PaymentPlan {
  const budget = Math.max(0, Math.floor(testBudgetMicro));
  if (budget <= largestPaymentMicro) return { payments: 1, firstMicro: budget, secondMicro: 0, fits: true, neededLargestMicro: budget };
  const second = Math.floor(budget / 2);
  const first = budget - second;
  return { payments: 2, firstMicro: first, secondMicro: second, fits: first <= largestPaymentMicro, neededLargestMicro: first };
}

/** The default budget for a new test: what one test needs, never more than two largest payments or what the month has left. */
export function defaultTestBudgetMicro(o: { leftThisMonthMicro: number; largestPaymentMicro: number; suggestedMicro?: number }): number {
  const want = Math.min(o.suggestedMicro ?? toMicroUsdc(DEFAULT_TEST_BUDGET_USDC), toMicroUsdc(DEFAULT_TEST_BUDGET_USDC));
  const cap = Math.min(want, o.largestPaymentMicro * 2, Math.max(0, o.leftThisMonthMicro));
  return Math.floor(cap / 10_000) * 10_000;
}

/** Where the next budget period starts: the old end, stepped forward by whole periods until it covers `now`. */
export function nextPeriod(previousEnd: Date, now: Date = new Date()): { startsAt: Date; endsAt: Date } {
  let start = previousEnd.getTime();
  const at = now.getTime();
  if (at >= start + BUDGET_PERIOD_MS) start += Math.floor((at - start) / BUDGET_PERIOD_MS) * BUDGET_PERIOD_MS;
  return { startsAt: new Date(start), endsAt: new Date(start + BUDGET_PERIOD_MS) };
}

/** "Dec 26" — the day a monthly budget starts again. */
export function resetLabel(endsAt: Date): string {
  return endsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
