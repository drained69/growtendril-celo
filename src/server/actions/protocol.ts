"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import type { Hex } from "viem";
import { schema as s } from "@/server/db/client";
import { toMicro } from "@/lib/money";
import { fail, guard, limited, type ActionResult } from "@/server/actions/_common";
import { checkVaultIntentTerms, ensureVaultIntent, INTENT_STATE, linkWorkspace, openVaultIntents, syncWorkspaceToChain } from "@/server/integrations/celo/protocol";
import { getWallet } from "@/server/integrations/celo/wallets";

export async function linkWorkspaceAction(address: string): Promise<ActionResult> {
  try {
    // Only the workspace owner decides which contract holds the team's money.
    const { project, db, user } = await guard("manage_workspace");
    await limited("protocol-link");
    await linkWorkspace(db, { projectId: project.id, userId: user.id, address });
    revalidatePath("/app", "layout");
    return { ok: true, message: "Workspace contract linked" };
  } catch (e) {
    return fail(e);
  }
}

export async function syncProtocolAction(): Promise<ActionResult> {
  try {
    const { project, db } = await guard("manage_wallet");
    await limited("protocol-sync", 6, 0.05);
    await syncWorkspaceToChain(db, project.id);
    revalidatePath("/app", "layout");
    return { ok: true, message: "Synced with Celo" };
  } catch (e) {
    return fail(e);
  }
}

/** Intents for this approval that are still open onchain, so a rejection also closes them in the contract. */
export async function openVaultIntentsAction(approvalId: string, amount?: string): Promise<ActionResult<{ workspace: string; intentIds: Hex[] }>> {
  try {
    const { project, db } = await guard("approve");
    const [approval] = await db.select().from(s.approvals).where(and(eq(s.approvals.id, approvalId), eq(s.approvals.projectId, project.id)));
    if (!approval?.transactionId) return { ok: false, error: "Approval not found" };
    const [tx] = await db.select().from(s.transactions).where(and(eq(s.transactions.id, approval.transactionId), eq(s.transactions.projectId, project.id)));
    if (!tx) return { ok: false, error: "Payment not found" };
    const amounts = [...new Set([approval.requestedMicro, tx.amountMicro, ...(amount ? [toMicro(amount)] : [])])];
    return { ok: true, data: await openVaultIntents(db, tx, amounts) };
  } catch (e) {
    return fail(e);
  }
}

/** The operator publishes the exact payment onchain. The approver then signs it from their own wallet. */
export async function prepareVaultApprovalAction(approvalId: string, amount?: string): Promise<ActionResult<{ workspace: string; intentId: Hex; needsSignature: boolean }>> {
  try {
    const { project, db } = await guard("approve");
    await limited("protocol-approval");
    const [approval] = await db.select().from(s.approvals).where(and(eq(s.approvals.id, approvalId), eq(s.approvals.projectId, project.id), eq(s.approvals.status, "pending")));
    if (!approval?.transactionId) return { ok: false, error: "This approval is no longer open" };
    const [tx] = await db.select().from(s.transactions).where(and(eq(s.transactions.id, approval.transactionId), eq(s.transactions.projectId, project.id)));
    const wallet = await getWallet(db, project.id);
    if (!tx || tx.kind !== "send" || wallet?.provider !== "growth_vault") return { ok: false, error: "This payment does not use a workspace contract" };
    if (wallet.frozen) return { ok: false, error: "Spending is frozen" };
    const amountMicro = amount ? toMicro(amount) : approval.requestedMicro;
    if (amountMicro <= 0 || amountMicro > approval.requestedMicro) return { ok: false, error: "The approved amount cannot exceed the request" };
    const intent = await ensureVaultIntent(db, tx, amountMicro);
    if (intent.state !== INTENT_STATE.Pending && intent.state !== INTENT_STATE.Approved) return { ok: false, error: "This payment is closed in the workspace contract" };
    const problem = await checkVaultIntentTerms(db, tx, amountMicro);
    if (problem) return { ok: false, error: problem };
    return { ok: true, data: { workspace: intent.workspace, intentId: intent.intentId, needsSignature: intent.state === INTENT_STATE.Pending } };
  } catch (e) {
    return fail(e);
  }
}
