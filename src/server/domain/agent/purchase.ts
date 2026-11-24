import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { canonicalJson, newId, sha256 } from "@/server/lib/ids";
import { fmtUsdc, microToDecimal, toMicro } from "@/lib/money";
import { CELO } from "@/server/integrations/celo/config";
import { researchSignerFor } from "@/server/integrations/celo/signer";
import { getWallet, walletIsLive } from "@/server/integrations/celo/wallets";
import { quote, pay, PaymentOutcomeUnknownError } from "@/server/integrations/celo/x402";
import { openException } from "@/server/domain/reconcile/exceptions";
import { safeErrorMessage } from "@/server/security/safe-error";
import { servicesWithCapability } from "@/server/integrations/celo/marketplace";
import { analyzeProject, type Logger } from "@/server/domain/intel/analyze";
import { evaluateInformationValue } from "@/server/domain/agent/information-value";
import { parseFinancialAction } from "@/server/domain/agent/actions";
import { evaluatePolicy } from "@/server/domain/agent/policy";
import { claimExecution, createTransaction, loadPolicy, loadPolicyState, transition } from "@/server/domain/agent/ledger";
import { recordDecision, updateDecision, writeReceipt } from "@/server/domain/agent/decisions";
import { notify } from "@/server/domain/notifications/webhooks";

/**
 * x402 AUTONOMOUS PURCHASING
 *
 *  need identified → find x402 service → live price quote → expected value of information
 *  → structured action (Zod) → policy engine → pay via Celo x402 → consume data
 *  → re-score → record receipt
 */

export interface PurchaseOutcome {
  decisionId: string;
  bought: boolean;
  state: string;
  confidenceBefore: number;
  confidenceAfter: number | null;
  priceMicro: number | null;
  settlementId: string | null;
  message: string;
}

/** How much a company-enrichment purchase is expected to move confidence, and how reliable it has been. */
const EXPECTED_LIFT = { company_enrichment: 0.2 };

interface EnrichmentSignal {
  signalType: "funding" | "hiring" | "initiative" | "tech_adoption" | "partnership" | "launch";
  summary: string;
  sourceUrl: string;
  observedAt: string;
  confidence: number;
}

export async function purchaseCompanyIntel(db: DB, p: { projectId: string; companyId: string; runId?: string | null; log?: Logger }): Promise<PurchaseOutcome> {
  const log = p.log ?? (() => {});
  const [company] = await db.select().from(s.companies).where(and(eq(s.companies.id, p.companyId), eq(s.companies.projectId, p.projectId)));
  if (!company) throw new Error("company not found");
  const [mission] = await db.select().from(s.missions).where(and(eq(s.missions.projectId, p.projectId), eq(s.missions.status, "active")));
  if (!mission) throw new Error("No active mission — purchases are always tied to a mission budget");
  const [opp] = await db.select().from(s.opportunities).where(and(eq(s.opportunities.projectId, p.projectId), eq(s.opportunities.subjectKey, `company:${company.id}`)));
  const policy = await loadPolicy(db, p.projectId);

  const before = company.confidence;
  const stake = Math.max(opp?.estimatedCostMicro ?? 0, toMicro(25));
  log("operator", `${company.name}: confidence ${(before * 100).toFixed(0)}% — evaluating whether more information is worth buying`);

  // 1. Discover a service that can answer the question.
  const candidates = (await servicesWithCapability(db, "company_enrichment"))
    .filter((c) => c.svc.network === CELO.caip2 && c.svc.priceMicro != null && c.svc.priceMicro > 0 && c.svc.resourceUrl.startsWith("https://"))
    .sort((a, b) => (a.svc.priceMicro ?? 1e12) - (b.svc.priceMicro ?? 1e12));
  const pick = candidates[0];
  if (!pick) throw new Error("No company-research service payable on Celo is listed on the configured Celo research catalog right now, so there's nothing to buy. GrowTendril keeps the free public evidence and checks the marketplace again each cycle.");
  log("operator", `Found ${pick.vendor.name} on the Celo research catalog — listed at ${fmtUsdc(pick.svc.priceMicro)}`);

  // 2. Live quote from the seller's 402 challenge (the price we evaluate is the price we'd pay).
  const url = new URL(pick.svc.resourceUrl);
  url.searchParams.set("company", company.name);
  if (company.githubOrg) url.searchParams.set("github", company.githubOrg);
  let liveQuote: Awaited<ReturnType<typeof quote>> | null = null;
  let quoteError: string | null = null;
  try {
    liveQuote = await quote(url.toString());
    if (liveQuote.kind !== "quote") quoteError = liveQuote.kind === "unsupported" ? liveQuote.reason : "endpoint did not require payment";
  } catch (e) {
    quoteError = safeErrorMessage(e);
  }
  if (liveQuote?.kind !== "quote") {
    const reason = `No compatible Celo mainnet quote from ${pick.vendor.name}${quoteError ? `: ${quoteError}` : ""}`;
    const d = await recordDecision(db, { projectId: p.projectId, missionId: mission.id, runId: p.runId, agent: "operator", kind: "skip_purchase", action: { action: "skip_purchase", serviceId: pick.svc.id }, rationale: reason, status: "executed", dataMode: "LIVE" });
    await writeReceipt(db, d.id);
    log("operator", reason);
    return { decisionId: d.id, bought: false, state: "SKIPPED", confidenceBefore: before, confidenceAfter: null, priceMicro: null, settlementId: null, message: reason };
  }
  const priceMicro = liveQuote.quote.amountMicro;

  // 3. Is it worth it?
  const ivi = evaluateInformationValue({ confidence: before, stakeMicro: stake, priceMicro, expectedLift: EXPECTED_LIFT.company_enrichment, reliability: 0.8, maxPerCallMicro: policy.hardCeilingMicro });
  const reasons = [...ivi.reasons];
  const projectMode = (await db.select({ m: s.projects.dataMode }).from(s.projects).where(eq(s.projects.id, p.projectId)))[0]?.m ?? "LIVE";

  if (!ivi.buy) {
    const d = await recordDecision(db, {
      projectId: p.projectId,
      missionId: mission.id,
      runId: p.runId,
      agent: "operator",
      kind: "skip_purchase",
      action: { action: "skip_purchase", serviceId: pick.svc.id, quotedPriceMicro: priceMicro },
      rationale: `Not worth buying data on ${company.name}: expected value ${fmtUsdc(ivi.eviMicro)} vs price ${fmtUsdc(priceMicro)}.`,
      inputs: { confidenceBefore: before, reasons, eviMicro: ivi.eviMicro },
      status: "executed",
      dataMode: projectMode,
    });
    await writeReceipt(db, d.id);
    log("operator", `Decided NOT to buy: ${reasons[3]}`);
    return { decisionId: d.id, bought: false, state: "SKIPPED", confidenceBefore: before, confidenceAfter: null, priceMicro, settlementId: null, message: "Information not worth its price" };
  }
  log("operator", `Worth buying: ${reasons[3]}`);

  // 4. Structured action → Zod → policy engine.
  const parsed = parseFinancialAction({
    action: "purchase_service",
    serviceId: pick.svc.id,
    resourceUrl: url.toString(),
    amount: microToDecimal(priceMicro),
    currency: "USDC",
    reasonCode: "VERIFY_CUSTOMER_INTENT",
    expectedValue: ivi.expectedValue,
    missionId: mission.id,
    confidence: before,
    subject: { type: "company", id: company.id },
    chain: CELO.appKitChain,
  });
  if (!parsed.success) throw new Error(`Action failed schema validation: ${parsed.error.message}`);
  const action = parsed.data;
  const pstate = await loadPolicyState(db, { projectId: p.projectId, missionId: mission.id, category: "research", serviceKnown: true });
  const verdict = evaluatePolicy(action, policy, pstate);
  log("policy", `purchase_service ${fmtUsdc(priceMicro)} → ${verdict.verdict}`);

  const decision = await recordDecision(db, {
    projectId: p.projectId,
    missionId: mission.id,
    runId: p.runId,
    agent: "operator",
    kind: "purchase_service",
    action: action as unknown as Record<string, unknown>,
    rationale: `Customer-intent confidence for ${company.name} was ${(before * 100).toFixed(0)}%. ${pick.vendor.name} can verify hiring, funding and adoption signals for ${fmtUsdc(priceMicro)}.`,
    inputs: { confidenceBefore: before, reasons, eviMicro: ivi.eviMicro, quoteError },
    policy: verdict,
    status: verdict.verdict === "ALLOW" ? "approved" : verdict.verdict === "DENY" ? "denied" : "awaiting_approval",
    dataMode: "LIVE",
  });
  const { tx, duplicate } = await createTransaction(db, {
    projectId: p.projectId,
    walletId: (await getWallet(db, p.projectId))?.id,
    decisionId: decision.id,
    missionId: mission.id,
    kind: "x402_purchase",
    rail: "celo_x402",
    budgetCategory: verdict.category,
    amountMicro: priceMicro,
    chain: CELO.appKitChain,
    recipient: liveQuote?.kind === "quote" ? liveQuote.quote.payTo : pick.svc.payTo,
    idempotencyKey: sha256(`x402:${p.projectId}:${company.id}:${pick.svc.id}:${new Date().toISOString().slice(0, 13)}`),
    dataMode: "LIVE",
  });
  if (duplicate) {
    log("operator", "Same purchase already made this hour — idempotency key matched; not paying twice");
    return { decisionId: tx.decisionId, bought: false, state: tx.state, confidenceBefore: before, confidenceAfter: null, priceMicro, settlementId: tx.settlementId, message: "Duplicate purchase prevented" };
  }

  if (verdict.verdict === "DENY") {
    await transition(db, tx.id, "DENIED", {}, verdict.checks.filter((c) => !c.passed).map((c) => c.rule).join(", "));
    await writeReceipt(db, decision.id);
    return { decisionId: decision.id, bought: false, state: "DENIED", confidenceBefore: before, confidenceAfter: null, priceMicro, settlementId: null, message: "Policy denied the purchase" };
  }
  if (verdict.verdict === "APPROVAL_REQUIRED") {
    await transition(db, tx.id, "AWAITING_APPROVAL");
    const approvalId = newId();
    await db.insert(s.approvals).values({ id: approvalId, projectId: p.projectId, decisionId: decision.id, transactionId: tx.id, title: `Buy data on ${company.name}`, details: { service: pick.vendor.name, reasons, policy: verdict.checks.filter((c) => !c.passed) }, requestedMicro: priceMicro });
    await writeReceipt(db, decision.id);
    await notify(db, p.projectId, { event: "approval.requested", key: `approval.requested:${approvalId}`, summary: `Approval needed: buy data on ${company.name} (${priceMicro / 1_000_000} USDC)`, path: "/app/approvals", data: { approval_id: approvalId, amount_usdc: priceMicro / 1_000_000 } });
    return { decisionId: decision.id, bought: false, state: "AWAITING_APPROVAL", confidenceBefore: before, confidenceAfter: null, priceMicro, settlementId: null, message: "Purchase needs founder approval" };
  }

  await transition(db, tx.id, "AUTHORIZED", {}, "policy ALLOW");
  return executePurchase(db, { txId: tx.id, decisionId: decision.id, projectId: p.projectId, companyId: company.id, url: url.toString(), liveQuote, priceMicro, before, serviceId: pick.svc.id, purpose: `Verify customer intent: ${company.name}`, log });
}

/** Execute an AUTHORIZED purchase (also used after founder approval). */
export async function executePurchase(
  db: DB,
  a: { txId: string; decisionId: string; projectId: string; companyId: string; url: string; liveQuote: Awaited<ReturnType<typeof quote>> | null; priceMicro: number; before: number; serviceId: string; purpose: string; log?: Logger },
): Promise<PurchaseOutcome> {
  const log = a.log ?? (() => {});
  const claim = await claimExecution(db, a.txId);
  if (!claim.claimed) return { decisionId: a.decisionId, bought: false, state: claim.state, confidenceBefore: a.before, confidenceAfter: null, priceMicro: a.priceMicro, settlementId: null, message: claim.message };

  const [company] = await db.select().from(s.companies).where(eq(s.companies.id, a.companyId));
  const [approvedTx] = await db.select().from(s.transactions).where(eq(s.transactions.id, a.txId));
  let data: { dataMode?: string; signals?: EnrichmentSignal[] } | null = null;
  let settlementId: string | null = null;
  let finalState: "SUBMITTED" | "FAILED" | "EXCEPTION" = "FAILED";
  let payer: string | null = null;
  let httpStatus: number | null = null;
  let failure: string | null = null;

  const wallet = await getWallet(db, a.projectId);
  const signer = walletIsLive(wallet) && !wallet!.frozen ? researchSignerFor(wallet) : null;
  if (signer && a.liveQuote?.kind === "quote" && approvedTx?.chain === CELO.appKitChain && approvedTx.amountMicro === a.priceMicro && approvedTx.recipient?.toLowerCase() === a.liveQuote.quote.payTo.toLowerCase() && a.liveQuote.quote.amountMicro <= a.priceMicro) {
    try {
      log("operator", `Signing x402 authorization for ${fmtUsdc(a.priceMicro)} (EIP-712, Celo wallet)`);
      const res = await pay(a.liveQuote.quote, signer, { maxAmountMicro: a.priceMicro });
      data = res.data as typeof data;
      settlementId = res.settlementId;
      payer = res.payer;
      httpStatus = res.status;
      finalState = "SUBMITTED";
      log("operator", `Celo facilitator returned payment receipt — settlement ${settlementId}`);
    } catch (e) {
      failure = safeErrorMessage(e);
      if (e instanceof PaymentOutcomeUnknownError) {
        finalState = "EXCEPTION";
        await openException(db, { scope: "wallet", projectId: a.projectId, kind: "payout_unverified", ref: `x402:${a.txId}`, transactionId: a.txId, amountMicro: a.priceMicro, counterparty: a.liveQuote.quote.payTo, detail: `${failure} ${fmtUsdc(a.priceMicro)} stays committed until the wallet's Celo history is checked.` });
        log("operator", `x402 payment needs review: ${failure}`);
      } else log("operator", `x402 payment failed: ${failure}`);
    }
  } else failure = signer ? "Seller payment terms changed after approval or no compatible Celo mainnet quote" : "No Celo mainnet wallet configured";

  const digest = data ? sha256(canonicalJson(data)) : null;
  await db.insert(s.x402Purchases).values({ id: newId(), transactionId: a.txId, serviceId: a.serviceId, resourceUrl: a.url, method: "GET", priceMicro: a.priceMicro, purpose: a.purpose, payer, network: CELO.caip2, httpStatus, responseDigest: digest, responseExcerpt: data ? (data as Record<string, unknown>) : null });
  await transition(db, a.txId, finalState, { settlementId, settlementStatus: settlementId ? "received" : null, error: failure }, failure ?? undefined);

  // Consume what we bought: each signal becomes attributable evidence.
  let added = 0;
  const paidData = data as { dataMode?: string; signals?: EnrichmentSignal[] } | null;
  if (finalState === "SUBMITTED" && paidData?.signals?.length) {
    const [purchase] = await db.select().from(s.x402Purchases).where(eq(s.x402Purchases.transactionId, a.txId));
    for (const sig of paidData.signals) {
      if (!sig.sourceUrl.startsWith("https://") || !Number.isFinite(Date.parse(sig.observedAt)) || sig.confidence < 0 || sig.confidence > 1) continue;
      const r = await db
        .insert(s.evidence)
        .values({
          id: newId(),
          projectId: a.projectId,
          companyId: a.companyId,
          purchaseId: purchase.id,
          dedupeKey: `x402:${a.companyId}:${sha256(sig.sourceUrl + sig.summary).slice(0, 16)}`,
          sourceUrl: sig.sourceUrl,
          sourceTitle: `Purchased via x402 — ${sig.summary.slice(0, 60)}`,
          provider: "x402",
          excerpt: sig.summary,
          signalType: sig.signalType,
          observedAt: new Date(sig.observedAt),
          weight: sig.confidence,
          classifiedBy: "x402",
          dataMode: "LIVE",
        })
        .onConflictDoNothing()
        .returning({ id: s.evidence.id });
      added += r.length;
    }
  }
  // Re-score with the new evidence (deterministic — the purchase can only move confidence by adding evidence).
  await analyzeProject(db, a.projectId, () => {});
  const [after] = await db.select().from(s.companies).where(eq(s.companies.id, a.companyId));
  const confidenceAfter = after?.confidence ?? null;
  await updateDecision(db, a.decisionId, {
    status: finalState === "SUBMITTED" ? "executed" : "failed",
    result: { confidenceAfter, signalsAdded: added, settlementId, state: finalState, summary: `${added} additional intent signal(s) found` },
    dataMode: "LIVE",
  });
  await writeReceipt(db, a.decisionId);
  log("operator", `${company.name}: ${added} new signal(s); confidence ${(a.before * 100).toFixed(0)}% → ${confidenceAfter != null ? (confidenceAfter * 100).toFixed(0) : "?"}%`);
  return { decisionId: a.decisionId, bought: finalState === "SUBMITTED", state: finalState, confidenceBefore: a.before, confidenceAfter, priceMicro: a.priceMicro, settlementId, message: failure ?? "Purchased" };
}

/** Latest purchases for the activity feed. */
export async function recentPurchases(db: DB, projectId: string, limit = 20) {
  return db
    .select({ p: s.x402Purchases, tx: s.transactions })
    .from(s.x402Purchases)
    .innerJoin(s.transactions, eq(s.x402Purchases.transactionId, s.transactions.id))
    .where(eq(s.transactions.projectId, projectId))
    .orderBy(desc(s.x402Purchases.createdAt))
    .limit(limit);
}
