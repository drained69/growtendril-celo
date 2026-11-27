"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/server/db/client";
import { audit } from "@/server/db/helpers";
import { sha256 } from "@/server/lib/ids";
import { toMicro } from "@/lib/money";
import { attachCircleWallet, getWallet, provisionWallet, walletIsLive } from "@/server/integrations/celo/wallets";
import { createTransaction, transition } from "@/server/domain/agent/ledger";
import { recordDecision, writeReceipt } from "@/server/domain/agent/decisions";
import { refreshSettlements } from "@/server/domain/agent/execute";
import { enqueue } from "@/server/jobs/queue";
import { kickWorker } from "@/server/jobs/worker";
import { fail, guard, limited, type ActionResult } from "@/server/actions/_common";
import { CELO } from "@/server/integrations/celo/config";
import { resolveException } from "@/server/domain/reconcile/exceptions";

export async function provisionWalletAction(): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    await limited(`wallet:${user.id}`, 3, 0.01);
    const w = await provisionWallet(db, { projectId: project.id, userId: user.id, projectName: project.name });
    revalidatePath("/app", "layout");
    return { ok: true, message: `Wallet ${w.address?.slice(0, 10)}… created on Celo mainnet` };
  } catch (e) {
    return fail(e);
  }
}

export async function attachWalletAction(circleWalletId: string): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    if (!/^0x[0-9a-f]{40}$/i.test(circleWalletId.trim())) return { ok: false, error: "Enter your Celo signer address" };
    const w = await attachCircleWallet(db, { projectId: project.id, userId: user.id, circleWalletId: circleWalletId.trim() });
    revalidatePath("/app", "layout");
    return { ok: true, message: `Attached ${w.address?.slice(0, 10)}…` };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleFreezeAction(): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    const w = await getWallet(db, project.id);
    if (!w) return { ok: false, error: "Set up your Payout account first." };
    await db.update(s.wallets).set({ frozen: !w.frozen }).where(eq(s.wallets.id, w.id));
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: w.frozen ? "wallet.unfreeze" : "wallet.freeze" });
    revalidatePath("/app", "layout");
    return { ok: true, message: w.frozen ? "Spending resumed" : "Kill switch on — every spend is denied" };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Founder-initiated treasury move: wallet USDC → Circle Gateway, so the agent can pay x402
 * services by signature. Recorded as a decision + transaction; executed by the job worker.
 */
export async function depositToGatewayAction(amount: string): Promise<ActionResult> {
  return { ok: false, error: "Celo x402 uses your wallet USDC balance directly; no deposit is needed." };
}

export async function refreshSettlementsAction(): Promise<ActionResult> {
  try {
    const { project, db } = await guard("view");
    const r = await refreshSettlements(db, project.id);
    revalidatePath("/app", "layout");
    return { ok: true, message: `Checked ${r.checked} in-flight payment(s), ${r.updated} updated${r.errors.length ? ` · ${r.errors[0]}` : ""}` };
  } catch (e) {
    return fail(e);
  }
}

export async function setKolPayoutAction(kolId: string, address: string): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    const a = address.trim();
    if (a && (!/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/i.test(a) || /^0x0{36}dead$/i.test(a))) return { ok: false, error: "Enter a valid recipient EVM address" };
    const [k] = await db.select({ payoutAddress: s.kols.payoutAddress }).from(s.kols).where(and(eq(s.kols.id, kolId), eq(s.kols.projectId, project.id)));
    if (!k) return { ok: false, error: "Creator not found" };
    if ((k.payoutAddress ?? "").toLowerCase() === a.toLowerCase()) return { ok: true, message: "No change" };
    await db.update(s.kols).set({ payoutAddress: a || null, updatedAt: new Date() }).where(and(eq(s.kols.id, kolId), eq(s.kols.projectId, project.id)));
    // Old and new address on record: payee changes are reviewed at approval time (see agent/payees.ts).
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "kol.payout_address", target: kolId, data: { from: k.payoutAddress ?? null, to: a || null } });
    revalidatePath(`/app/kols/${kolId}`);
    return { ok: true, message: a ? "Payout address saved" : "Payout address cleared" };
  } catch (e) {
    return fail(e);
  }
}

/** Close a ledger exception with a note saying what was found. Nothing is changed in the books. */
export async function resolveLedgerExceptionAction(exceptionId: string, _: unknown, form: FormData): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    const resolution = String(form.get("resolution") ?? "");
    const done = await resolveException(db, { id: exceptionId, userId: user.id, resolution, projectId: project.id });
    if (!done) return { ok: false, error: "Already resolved, or not in this workspace" };
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "ledger.exception_resolved", target: exceptionId, data: { resolution: resolution.trim().slice(0, 500) } });
    revalidatePath("/app", "layout");
    return { ok: true, message: "Marked resolved" };
  } catch (e) {
    return fail(e);
  }
}

// ───────────────────────────── owner withdrawal ─────────────────────────────

const WithdrawInput = z.object({ amount: z.string().trim().min(1, "Enter an amount"), to: z.string().trim().min(1, "Enter a destination address"), toConfirm: z.string().trim() });

function readWithdrawForm(form: FormData) {
  const f = WithdrawInput.parse({ amount: form.get("amount") ?? "", to: form.get("to") ?? "", toConfirm: form.get("toConfirm") ?? "" });
  if (f.to.toLowerCase() !== f.toConfirm.toLowerCase()) throw new Error("The two addresses don't match. Paste the destination again in both fields.");
  return f;
}

/** Step 1: check the request and email the owner a code bound to this amount and address. */
export async function requestWithdrawalCodeAction(_: unknown, form: FormData): Promise<ActionResult<{ summary: string }>> {
  try {
    const { project, db, user } = await guard("manage_workspace");
    await limited(`withdraw-code:${user.id}`, 5, 0.02);
    const f = readWithdrawForm(form);
    const { checkWithdrawal, withdrawalScope } = await import("@/server/domain/agent/withdraw");
    const { issueCode } = await import("@/server/domain/auth/codes");
    const { fmtUsdc } = await import("@/lib/money");
    const w = await checkWithdrawal(db, project.id, f);
    const summary = `${fmtUsdc(w.amountMicro)} from ${w.walletAddress} to ${w.to} on Celo`;
    await issueCode(db, user, "withdraw", Date.now(), { scope: withdrawalScope(project.id, w.amountMicro, w.to), summary });
    return { ok: true, data: { summary }, message: `We emailed a code to ${user.email}. It works only for this amount and address.` };
  } catch (e) {
    return fail(e);
  }
}

/** Step 2: consume the code and send. */
export async function withdrawAction(_: unknown, form: FormData): Promise<ActionResult<{ state: string; txHash: string | null }>> {
  try {
    const { project, db, user } = await guard("manage_workspace");
    await limited(`withdraw:${user.id}`, 5, 0.02);
    const f = readWithdrawForm(form);
    const { checkWithdrawal, withdraw, withdrawalScope } = await import("@/server/domain/agent/withdraw");
    const { consumeCode } = await import("@/server/domain/auth/codes");
    const { fmtUsdc } = await import("@/lib/money");
    const checked = await checkWithdrawal(db, project.id, f);
    const codeId = await consumeCode(db, user.id, "withdraw", String(form.get("code") ?? ""), Date.now(), withdrawalScope(project.id, checked.amountMicro, checked.to));
    const r = await withdraw(db, { projectId: project.id, userId: user.id, amount: f.amount, to: checked.to, requestKey: codeId });
    revalidatePath("/app", "layout");
    if (r.state === "FAILED") return { ok: false, error: "The withdrawal didn't go out. Nothing left the wallet — check the receipt for the reason, then try again." };
    return { ok: true, data: { state: r.state, txHash: r.txHash }, message: `${fmtUsdc(r.amountMicro)} ${r.state === "SETTLED" ? "settled at" : "sent to"} ${r.to.slice(0, 6)}…${r.to.slice(-4)} on Celo` };
  } catch (e) {
    return fail(e);
  }
}
