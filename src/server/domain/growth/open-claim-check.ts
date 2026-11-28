import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { sha256 } from "@/server/lib/ids";
import { MAX_CLAIM_TRIES, SPOT_TAKING } from "@/lib/open-campaigns";
import { notify } from "@/server/domain/notifications/webhooks";
import { proofReader, type ProofRead, type ProofReader } from "@/server/domain/growth/open-proof";
import { tellOwnerNeedsYou } from "@/server/domain/growth/open-emails";

export type ClaimCheck = { key: string; result: "pass" | "fail" | "unsure"; detail: string };
export type ClaimDecision = { status: "rejected" | "needs_owner" | "approved_waiting"; checks: ClaimCheck[]; reason: string | null };

export interface ClaimFacts {
  campaign: { status: string; endsAt: Date | null; slots: number; termsHash: string | null; autoApprove: boolean; requiredText: string | null };
  participant: { code: string; trackedPath: string };
  claim: { createdAt: Date; attempts: number };
  agreement: { termsHash: string } | null;
  /** Spots already held by other approved or paid claims. */
  takenSpots: number;
  duplicateUrl: boolean;
  duplicateAuthor: boolean;
  read: ProofRead;
}

const has = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());

/**
 * Deterministic checks only. A readable post that is certainly missing the code or the required words is
 * sent back (the person can fix it and try again); anything unreadable, unusual or unsure goes to the
 * owner. Nothing here reads instructions from the post, so its words can't change the outcome.
 */
export function decideClaim(f: ClaimFacts): ClaimDecision {
  const checks: ClaimCheck[] = [];
  const add = (key: string, result: ClaimCheck["result"], detail: string) => { checks.push({ key, result, detail }); return result; };
  add("agreement", f.agreement && f.campaign.termsHash && f.agreement.termsHash.toLowerCase() === f.campaign.termsHash.toLowerCase() ? "pass" : "fail",
    f.agreement ? "Signed the campaign terms with their payout wallet" : "No signed agreement for these terms");
  add("on_time", ["live", "ended"].includes(f.campaign.status) && !!f.campaign.endsAt && f.claim.createdAt <= f.campaign.endsAt ? "pass" : "fail",
    "Sent before the campaign ended");
  add("spots", f.takenSpots < f.campaign.slots ? "pass" : "unsure", f.takenSpots < f.campaign.slots ? `${f.campaign.slots - f.takenSpots} of ${f.campaign.slots} spots left` : "All spots are already taken");
  add("one_per_person", "pass", "One claim per person and per wallet");
  add("unique_link", f.duplicateUrl ? "fail" : "pass", f.duplicateUrl ? "Someone else already sent this link" : "Nobody else sent this link");
  add("readable", f.read.ok ? "pass" : "unsure", f.read.ok ? "We could read the post" : f.read.reason);
  add("unique_account", f.duplicateAuthor ? "unsure" : "pass", f.duplicateAuthor ? "Another person in this campaign sent a post from the same account" : f.read.author ? "First post from this account" : "We couldn't tell which account posted it");
  let missing: string | null = null;
  if (f.read.ok) {
    const text = f.read.text, shown = has(text, f.participant.code) || has(text, f.participant.trackedPath);
    if (add("code_or_link", shown ? "pass" : f.read.exact ? "fail" : "unsure", shown ? "Shows their personal code or link" : `We couldn't find the code ${f.participant.code} or their personal link`) === "fail")
      missing = `We couldn't find your code ${f.participant.code} (or your personal link) in the post`;
    if (f.campaign.requiredText) {
      const words = has(text, f.campaign.requiredText);
      if (add("required_text", words ? "pass" : f.read.exact ? "fail" : "unsure", words ? `Includes "${f.campaign.requiredText}"` : `We couldn't find "${f.campaign.requiredText}"`) === "fail")
        missing = missing ? `${missing}, or the words "${f.campaign.requiredText}"` : `We couldn't find the words "${f.campaign.requiredText}" in the post`;
    }
  }
  const failedHard = checks.some(c => c.result === "fail" && ["agreement", "on_time", "unique_link"].includes(c.key));
  if (!failedHard && missing) {
    const left = MAX_CLAIM_TRIES - f.claim.attempts;
    return { status: "rejected", checks, reason: left > 0 ? `${missing}. Fix the post and send it again (${left} ${left === 1 ? "try" : "tries"} left).` : `${missing}.` };
  }
  if (failedHard || checks.some(c => c.result !== "pass")) return { status: "needs_owner", checks, reason: null };
  if (!f.campaign.autoApprove) return { status: "needs_owner", checks: [...checks, { key: "auto", result: "unsure", detail: "Automatic approval is off, so you decide" }], reason: null };
  return { status: "approved_waiting", checks, reason: null };
}

/** Runs the checks on a claim still marked "checking" and records the outcome. Safe to run twice. */
export async function checkOpenClaim(db: DB, claimId: string, read: ProofReader = proofReader()): Promise<ClaimDecision | null> {
  const [row] = await db.select({ claim: s.openClaims, participant: s.openParticipants, campaign: s.openCampaigns, slots: s.creatorPrograms.slots, link: s.campaigns.referralCode })
    .from(s.openClaims)
    .innerJoin(s.openParticipants, eq(s.openParticipants.id, s.openClaims.participantId))
    .innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openClaims.openCampaignId))
    .innerJoin(s.creatorPrograms, eq(s.creatorPrograms.id, s.openCampaigns.programId))
    .innerJoin(s.campaigns, eq(s.campaigns.id, s.openParticipants.campaignId))
    .where(eq(s.openClaims.id, claimId));
  if (!row || row.claim.status !== "checking") return null;
  const { claim, participant, campaign } = row;
  const [agreement] = await db.select({ termsHash: s.openAgreements.termsHash }).from(s.openAgreements).where(eq(s.openAgreements.participantId, participant.id));
  const others = and(eq(s.openClaims.openCampaignId, campaign.id), ne(s.openClaims.id, claim.id));
  const [{ n: takenSpots }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.openClaims).where(and(others, inArray(s.openClaims.status, SPOT_TAKING)));
  const [dupUrl] = await db.select({ id: s.openClaims.id }).from(s.openClaims).where(and(others, eq(s.openClaims.proofUrl, claim.proofUrl))).limit(1);
  const result = await read(claim.proofUrl, campaign.proofKind as never);
  const [dupAuthor] = result.author ? await db.select({ id: s.openClaims.id }).from(s.openClaims).where(and(others, eq(s.openClaims.author, result.author), notInArray(s.openClaims.status, ["rejected"]))).limit(1) : [];
  const decision = decideClaim({
    campaign: { ...campaign, slots: row.slots }, participant: { code: participant.code, trackedPath: `/r/${row.link}` }, claim, agreement: agreement ?? null,
    takenSpots, duplicateUrl: !!dupUrl, duplicateAuthor: !!dupAuthor, read: result,
  });
  const auto = decision.status !== "needs_owner";
  const updated = await db.update(s.openClaims).set({
    status: decision.status, checks: decision.checks, author: result.author, proofTextHash: result.ok ? sha256(result.text) : null,
    rejectReason: decision.reason, decidedBy: auto ? "auto" : null, decidedAt: auto ? new Date() : null, updatedAt: new Date(),
  }).where(and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, "checking"))).returning({ id: s.openClaims.id });
  if (updated.length && decision.status === "needs_owner") {
    await notify(db, campaign.projectId, { event: "creator.post_submitted", key: `open.needs_owner:${claim.id}:${claim.attempts}`, summary: `A claim in "${campaign.title}" needs you`, path: `/app/campaigns/${campaign.programId}`, data: { claim_id: claim.id } });
    await tellOwnerNeedsYou(db, claim.id);
  }
  return updated.length ? decision : null;
}
