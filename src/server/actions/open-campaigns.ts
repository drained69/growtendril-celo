"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { currentUser } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { fail, guard, limited, type ActionResult } from "@/server/actions/_common";
import {
  approveOpenClaim, confirmOpenAgent, confirmOpenFunding, confirmOpenObjection, confirmOpenRefund, createOpenCampaign, endOpenCampaign, joinOpenCampaign,
  openAgreementFor, openByProgram, prepareOpenFunding, rejectOpenClaim, setOpenAutoApprove, submitOpenClaim, syncOpenClaim, type FundingParams,
} from "@/server/domain/growth/open-campaigns";

const refresh = () => { revalidatePath("/app/campaigns", "layout"); revalidatePath("/creator", "layout"); revalidatePath("/join", "layout"); };
const hash = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;

async function participant() {
  const user = await currentUser();
  if (!user) throw new Error("Sign in first");
  if (!user.emailVerified) throw new Error("Confirm your email first. Enter the code we sent you.");
  await limited(`open-join:${user.id}`, 12, 0.1);
  return { user, db: await getDb() };
}

// ── owner ──
export async function createOpenCampaignAction(_: unknown, form: FormData): Promise<ActionResult<{ url: string }>> {
  try {
    const { db, project, user } = await guard("manage_policy");
    await limited(`open-create:${project.id}`, 5, 0.02);
    const { programId } = await createOpenCampaign(db, project.id, user.id, Object.fromEntries(form)); refresh();
    return { ok: true, data: { url: `/app/campaigns/${programId}/fund` }, message: "Campaign saved. Next, set the money aside." };
  } catch (e) { return fail(e); }
}
export async function prepareOpenFundingAction(programId: string): Promise<ActionResult<FundingParams>> {
  try { const { db, project, user } = await guard("approve"); const data = await prepareOpenFunding(db, project.id, user.id, programId); refresh(); return { ok: true, data }; }
  catch (e) { return fail(e); }
}
export async function confirmOpenFundingAction(programId: string, owner: string, txHash: string | null): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); await confirmOpenFunding(db, project.id, user.id, programId, owner, hash(txHash)); refresh(); return { ok: true, message: "The money is set aside. Your campaign is open." }; }
  catch (e) { return fail(e); }
}
export async function approveOpenClaimAction(programId: string, claimId: string): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); await approveOpenClaim(db, project.id, user.id, programId, claimId); refresh(); return { ok: true, message: "Approved. The reward is paid after a 3-day hold." }; }
  catch (e) { return fail(e); }
}
export async function rejectOpenClaimAction(programId: string, claimId: string, _: unknown, form: FormData): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); await rejectOpenClaim(db, project.id, user.id, programId, claimId, String(form.get("reason") ?? "")); refresh(); return { ok: true, message: "Done. This person won't be paid." }; }
  catch (e) { return fail(e); }
}
export async function confirmOpenObjectionAction(programId: string, claimId: string, reason: string, txHash: string | null): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); await confirmOpenObjection(db, project.id, user.id, programId, claimId, reason, hash(txHash)); refresh(); return { ok: true, message: "Objection recorded. The money went back into the campaign." }; }
  catch (e) { return fail(e); }
}
/** After the owner set a reward aside from their own wallet. */
export async function syncOwnerClaimAction(programId: string, claimId: string): Promise<ActionResult> {
  try {
    const { db, project } = await guard("approve");
    const { campaign } = await openByProgram(db, project.id, programId);
    const [claim] = await db.select({ id: s.openClaims.id }).from(s.openClaims).where(and(eq(s.openClaims.id, claimId), eq(s.openClaims.openCampaignId, campaign.id)));
    if (!claim) throw new Error("Claim not found");
    const state = await syncOpenClaim(db, claim.id); refresh();
    return state === "None" ? { ok: false, error: "Celo doesn't show this reward yet. Wait a few seconds and try again." } : { ok: true, message: "Updated from Celo" };
  } catch (e) { return fail(e); }
}
export async function setOpenAutoApproveAction(programId: string, on: boolean): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); await setOpenAutoApprove(db, project.id, user.id, programId, on); refresh(); return { ok: true, message: on ? "Automatic approval is on" : "Automatic approval is off. You'll approve each claim." }; }
  catch (e) { return fail(e); }
}
export async function confirmOpenAgentAction(programId: string): Promise<ActionResult> {
  try { const { db, project, user } = await guard("approve"); const agent = await confirmOpenAgent(db, project.id, user.id, programId); refresh(); return { ok: true, message: agent ? "GrowTendril can approve rewards again" : "GrowTendril can no longer approve rewards in this campaign" }; }
  catch (e) { return fail(e); }
}
export async function endOpenCampaignAction(programId: string): Promise<ActionResult> {
  try { const { db, project, user } = await guard("manage_policy"); await endOpenCampaign(db, project.id, user.id, programId); refresh(); return { ok: true, message: "The campaign has stopped taking new people" }; }
  catch (e) { return fail(e); }
}
export async function confirmOpenRefundAction(programId: string, txHash: string | null): Promise<ActionResult> {
  try { const { db, project, user } = await guard("manage_policy"); await confirmOpenRefund(db, project.id, user.id, programId, hash(txHash)); refresh(); return { ok: true, message: "The unused money is back in your wallet" }; }
  catch (e) { return fail(e); }
}

// ── participant ──
export async function openAgreementAction(slug: string, address: string): Promise<ActionResult<{ message: string; issuedAt: string }>> {
  try { const { user, db } = await participant(); return { ok: true, data: await openAgreementFor(db, user.id, slug, address) }; }
  catch (e) { return fail(e); }
}
export async function joinOpenCampaignAction(slug: string, address: string, issuedAt: string, signature: string): Promise<ActionResult> {
  try { const { user, db } = await participant(); await joinOpenCampaign(db, user.id, slug, { address, issuedAt, signature }); refresh(); return { ok: true, message: "You've joined. Now do the task." }; }
  catch (e) { return fail(e); }
}
export async function submitOpenClaimAction(participantId: string, _: unknown, form: FormData): Promise<ActionResult> {
  try { const { user, db } = await participant(); await submitOpenClaim(db, user.id, participantId, String(form.get("url") ?? "")); refresh(); return { ok: true, message: "Thanks. We've checked your proof." }; }
  catch (e) { return fail(e); }
}
/** After the participant collected their reward from their own wallet. */
export async function syncMyClaimAction(claimId: string): Promise<ActionResult> {
  try {
    const { user, db } = await participant();
    const [mine] = await db.select({ id: s.openClaims.id }).from(s.openClaims).innerJoin(s.openParticipants, eq(s.openParticipants.id, s.openClaims.participantId))
      .where(and(eq(s.openClaims.id, claimId), eq(s.openParticipants.userId, user.id)));
    if (!mine) throw new Error("Claim not found");
    await syncOpenClaim(db, mine.id); refresh(); return { ok: true, message: "Updated from Celo" };
  } catch (e) { return fail(e); }
}
