import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { sendEmail } from "@/server/integrations/email";
import { fmtUsdc } from "@/lib/money";
import { COLLECT_WINDOW_MS } from "@/lib/open-campaigns";

/**
 * Plain emails at the moments that matter in an open campaign. Each is sent right after the status
 * change that causes it, so it goes out once. A failed email never blocks the campaign.
 */
const app = () => process.env.APP_URL?.trim().replace(/\/$/, "") || "https://celo.growtendril.xyz";
const day = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const hi = (name: string) => `Hi ${name.trim().split(" ")[0] || "there"},`;

async function context(db: DB, claimId: string) {
  const [r] = await db.select({ claim: s.openClaims, participant: s.openParticipants, campaign: s.openCampaigns, base: s.creatorPrograms.baseMicro, user: { id: s.users.id, email: s.users.email, name: s.users.name }, business: s.projects.name, ownerId: s.projects.ownerId })
    .from(s.openClaims).innerJoin(s.openParticipants, eq(s.openParticipants.id, s.openClaims.participantId))
    .innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openClaims.openCampaignId))
    .innerJoin(s.creatorPrograms, eq(s.creatorPrograms.id, s.openCampaigns.programId))
    .innerJoin(s.users, eq(s.users.id, s.openParticipants.userId))
    .innerJoin(s.projects, eq(s.projects.id, s.openCampaigns.projectId))
    .where(eq(s.openClaims.id, claimId));
  return r ?? null;
}

export type ParticipantNews = "approved" | "paid" | "objected" | "turned_down";

export async function tellParticipant(db: DB, claimId: string, news: ParticipantNews) {
  try {
    const r = await context(db, claimId);
    if (!r) return;
    const { claim, campaign: c, business } = r, amount = fmtUsdc(claim.amountMicro ?? r.base), url = `${app()}/creator/join/${c.slug}`;
    const wallet = `${r.participant.payoutAddress.slice(0, 6)}…${r.participant.payoutAddress.slice(-4)}`;
    const m = news === "approved" && claim.claimableAt ? {
      subject: `Approved: ${amount} from ${business}`,
      text: `${hi(r.user.name)}\n\nYour proof for "${c.title}" was approved, and ${amount} is set aside for you on Celo.\n\n${business} can still object until ${day(claim.claimableAt)}. From then you can collect it yourself on the campaign page (it needs a few cents of CELO for the network fee). If you don't, we'll send it to your wallet ${wallet} by ${day(new Date(claim.claimableAt.getTime() + COLLECT_WINDOW_MS))}.`,
    } : news === "paid" ? {
      subject: `Paid: ${amount} from ${business}`,
      text: `${hi(r.user.name)}\n\n${amount} for "${c.title}" was sent to your wallet ${wallet}.${claim.payTx ? `\n\nSee it on Celoscan: https://celoscan.io/tx/${claim.payTx}` : ""}\n\nThanks for taking part.`,
    } : news === "objected" ? {
      subject: `${business} objected to your reward`,
      text: `${hi(r.user.name)}\n\n${business} objected to your reward for "${c.title}", so it won't be paid.${claim.objectionReason ? `\n\nTheir reason: ${claim.objectionReason}` : ""}`,
    } : news === "turned_down" ? {
      subject: `Your claim for "${c.title}" wasn't accepted`,
      text: `${hi(r.user.name)}\n\n${business} looked at your proof for "${c.title}" and didn't accept it.${claim.rejectReason ? `\n\nTheir reason: ${claim.rejectReason}` : ""}`,
    } : null;
    if (!m) return;
    await sendEmail(db, { to: r.user.email, userId: r.user.id, kind: "campaign_update", ...m, action: { label: "Open your campaign", url } });
  } catch (e) {
    console.warn(`[open-campaigns] email to participant failed: ${(e as Error).message}`);
  }
}

export async function tellOwnerNeedsYou(db: DB, claimId: string) {
  try {
    const r = await context(db, claimId);
    if (!r) return;
    const [owner] = await db.select({ id: s.users.id, email: s.users.email, name: s.users.name }).from(s.users).where(eq(s.users.id, r.ownerId));
    if (!owner) return;
    await sendEmail(db, {
      to: owner.email, userId: owner.id, kind: "campaign_update",
      subject: `A claim in "${r.campaign.title}" needs you`,
      text: `${hi(owner.name)}\n\n${r.user.name} sent proof for "${r.campaign.title}". GrowTendril couldn't confirm everything automatically, so it's waiting for you to approve it or turn it down.\n\nProof: ${r.claim.proofUrl}\n\nAfter you approve, the reward still waits 3 days, and you can object during that time.`,
      action: { label: "Review the claim", url: `${app()}/app/campaigns/${r.campaign.programId}` },
    });
  } catch (e) {
    console.warn(`[open-campaigns] email to owner failed: ${(e as Error).message}`);
  }
}
