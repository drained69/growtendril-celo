"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { schema as s } from "@/server/db/client";
import { resolveApproval } from "@/server/domain/agent/execute";
import { collector, fail, guard, type ActionResult } from "@/server/actions/_common";
import { assertVaultApproved } from "@/server/integrations/celo/protocol";
import { toMicro } from "@/lib/money";

/** Only owners and admins may resolve spend approvals. */
export async function resolveApprovalAction(approvalId: string, resolution: "approve" | "reject", amount?: string, note?: string): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("approve");
    const [ap] = await db.select().from(s.approvals).where(and(eq(s.approvals.id, approvalId), eq(s.approvals.projectId, project.id)));
    if (!ap) return { ok: false, error: "This request is no longer waiting. Refresh the page to see where it went." };
    if (resolution === "approve" && ap.transactionId) {
      const [[tx], [wallet]] = await Promise.all([
        db.select().from(s.transactions).where(eq(s.transactions.id, ap.transactionId)),
        db.select({ provider: s.wallets.provider }).from(s.wallets).where(eq(s.wallets.projectId, project.id)),
      ]);
      // The contract is the authority: no signed onchain approval means the app cannot approve this payment.
      if (tx?.kind === "send" && wallet?.provider === "growth_vault") await assertVaultApproved(db, tx, amount ? toMicro(amount) : ap.requestedMicro);
    }
    const { log, push } = collector();
    const r = await resolveApproval(db, { approvalId, userId: user.id, resolution, modifiedAmount: amount || undefined, note: note?.slice(0, 500), log: push });
    revalidatePath("/app", "layout");
    return { ok: true, data: r, log, message: r.status === "approved" ? "Paid — it shows in Activity with its receipt" : r.status === "denied" ? "Not paid: one of your limits stopped it when we checked again. Its receipt says which." : "Not paid" };
  } catch (e) {
    return fail(e);
  }
}
