import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { audit, nextNumber } from "@/server/db/helpers";
import { newId, shortCode } from "@/server/lib/ids";
import {
  AGREEMENT_MAX_AGE_MS, CELO_USDC, MAX_CLAIM_TRIES, OPEN_REVIEW_WINDOW_SECONDS, OPEN_TERMS_VERSION, OpenCampaignInput, PROOF_HOSTS, PROOF_LABEL, SLUG_RE, SPOT_TAKING, ZERO_ADDRESS,
  agreementMessage, openCampaignKey, openEconomics, openRewardId, openSalt, openTermsHash, openTermsText, slugify,
  type OnchainCampaign, type OnchainReward, type ProofKind,
} from "@/lib/open-campaigns";
import { publicLink } from "@/lib/creator-campaigns";
import { isPayableAddress } from "@/server/domain/growth/experiments";
import { currentMonth } from "@/server/domain/growth/monthly-budget";
import { checkOpenClaim } from "@/server/domain/growth/open-claim-check";
import type { ProofReader } from "@/server/domain/growth/open-proof";

/** Chain access, injectable so tests never touch Celo. */
export interface OpenChain {
  contract(): Address | null;
  agent(): Address | null;
  readCampaign(contract: Address, id: Hex): Promise<OnchainCampaign>;
  readReward(contract: Address, id: Hex, rewardId: Hex): Promise<OnchainReward>;
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
}
export async function liveChain(): Promise<OpenChain> {
  const e = await import("@/server/integrations/celo/campaign-escrow");
  const { publicClient } = await import("@/server/integrations/celo/client");
  return {
    contract: e.campaignEscrowAddress, agent: e.openAgentAddress, readCampaign: e.readOpenCampaign, readReward: e.readOpenReward,
    // viem verifies ordinary wallets, smart-contract wallets (ERC-1271) and not-yet-deployed ones (ERC-6492).
    verifyMessage: (address, message, signature) => publicClient().verifyMessage({ address, message, signature }),
  };
}

const lower = (a: string | null | undefined) => (a ?? "").toLowerCase();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function participantCode() {
  const bytes = randomBytes(6);
  return `GT-${[...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}
async function locked<T>(db: DB, key: string, work: (db: DB) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return work(tx as unknown as DB);
  });
}
const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
export const reviewEndsAt = (endsAt: Date) => new Date(endsAt.getTime() + OPEN_REVIEW_WINDOW_SECONDS * 1000);

// ───────────────────────────── reads ─────────────────────────────

export async function openByProgram(db: DB, projectId: string, programId: string) {
  const [row] = await db.select({ campaign: s.openCampaigns, program: s.creatorPrograms }).from(s.openCampaigns)
    .innerJoin(s.creatorPrograms, eq(s.creatorPrograms.id, s.openCampaigns.programId))
    .where(and(eq(s.openCampaigns.programId, programId), eq(s.openCampaigns.projectId, projectId)));
  if (!row) throw new Error("Campaign not found");
  return row;
}
export async function openBySlug(db: DB, slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  const [row] = await db.select({ campaign: s.openCampaigns, program: s.creatorPrograms, business: s.projects.name, website: s.projects.website })
    .from(s.openCampaigns).innerJoin(s.creatorPrograms, eq(s.creatorPrograms.id, s.openCampaigns.programId))
    .innerJoin(s.projects, eq(s.projects.id, s.openCampaigns.projectId)).where(eq(s.openCampaigns.slug, slug));
  return row ?? null;
}
export async function takenSpots(db: DB, openCampaignId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.openClaims).where(and(eq(s.openClaims.openCampaignId, openCampaignId), inArray(s.openClaims.status, SPOT_TAKING)));
  return n;
}
/** Everything the owner's dashboard lists, newest first. */
export async function openClaimsFor(db: DB, openCampaignId: string) {
  return db.select({ claim: s.openClaims, participant: s.openParticipants, user: { name: s.users.name, email: s.users.email } })
    .from(s.openClaims).innerJoin(s.openParticipants, eq(s.openParticipants.id, s.openClaims.participantId))
    .innerJoin(s.users, eq(s.users.id, s.openParticipants.userId))
    .where(eq(s.openClaims.openCampaignId, openCampaignId)).orderBy(desc(s.openClaims.updatedAt));
}
export async function openParticipantCount(db: DB, openCampaignId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.openParticipants).where(eq(s.openParticipants.openCampaignId, openCampaignId));
  return n;
}
/** A participant's own view: their join, agreement, tracked link and claim. */
export async function myOpenJoin(db: DB, userId: string, openCampaignId: string) {
  const [row] = await db.select({ participant: s.openParticipants, link: s.campaigns.referralCode, claim: s.openClaims })
    .from(s.openParticipants).innerJoin(s.campaigns, eq(s.campaigns.id, s.openParticipants.campaignId))
    .leftJoin(s.openClaims, eq(s.openClaims.participantId, s.openParticipants.id))
    .where(and(eq(s.openParticipants.openCampaignId, openCampaignId), eq(s.openParticipants.userId, userId)));
  return row ?? null;
}
export async function myOpenJoins(db: DB, userId: string) {
  return db.select({ participant: s.openParticipants, campaign: s.openCampaigns, business: s.projects.name, claim: s.openClaims })
    .from(s.openParticipants).innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openParticipants.openCampaignId))
    .innerJoin(s.projects, eq(s.projects.id, s.openCampaigns.projectId))
    .leftJoin(s.openClaims, eq(s.openClaims.participantId, s.openParticipants.id))
    .where(eq(s.openParticipants.userId, userId)).orderBy(desc(s.openParticipants.joinedAt));
}

// ───────────────────────────── owner: create and fund ─────────────────────────────

export async function createOpenCampaign(db: DB, projectId: string, userId: string, input: unknown) {
  const v = OpenCampaignInput.parse(input), economics = openEconomics(v);
  const mission = await currentMonth(db, projectId);
  if (!mission) throw new Error("Set your monthly budget on the Goal page first, then create a campaign.");
  const [project] = await db.select().from(s.projects).where(eq(s.projects.id, projectId));
  const now = new Date(), endsAt = new Date(now.getTime() + v.days * 86_400_000);
  const experimentId = newId(), programId = newId(), id = newId(), slug = `${slugify(v.title)}-${shortCode(6)}`;
  await db.transaction(async tx => {
    // Budget 0: the money sits in the campaign contract, not in the monthly budget, so it is never counted twice.
    await tx.insert(s.experiments).values({ id: experimentId, projectId, missionId: mission.id, number: await nextNumber(tx as unknown as DB, "experiments", projectId),
      title: v.title, hypothesis: `People who ${v.task.slice(0, 160)} bring in new customers.`, channel: "creator_program", budgetCategory: "kol",
      target: `${v.people} people`, action: v.task, budgetMicro: 0, successEvent: "signup", successTarget: v.people, stopMaxCpaMicro: v.reward, stopAfterSpendMicro: 0,
      timeframeDays: v.days, startsAt: now, endsAt, status: "running", dataMode: "LIVE" });
    await tx.insert(s.creatorPrograms).values({ id: programId, projectId, experimentId, topic: v.title, platform: v.proofKind, brief: v.task, slots: v.people,
      cashLimitMicro: economics.totalMicro, baseMicro: v.reward, qualityBonusMicro: 0, outcomeBonusMicro: 0, outcomeCap: 0, mode: "open", escrowVersion: "campaign-escrow-1" });
    await tx.insert(s.openCampaigns).values({ id, projectId, programId, slug, title: v.title, task: v.task, proofKind: v.proofKind, requiredText: v.requiredText,
      durationDays: v.days, createdBy: userId });
  });
  await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.create", target: id, data: { ...economics, terms: v, business: project.name } });
  return { programId, id, slug };
}

export interface FundingParams { contract: Address; usdc: Address; salt: Hex; agent: Address; deadline: number; budgetMicro: number; baseMicro: number; slots: number; termsHash: Hex; attribution: Hex | null; campaignId: Hex | null; owner: string | null }

function attributionSuffix(): Hex | null {
  const code = process.env.CELO_ATTRIBUTION_CODE;
  return code && /^[a-z0-9_]{1,32}$/.test(code) ? toDataSuffix(code) as Hex : null;
}
export function fundingParams(c: typeof s.openCampaigns.$inferSelect, p: typeof s.creatorPrograms.$inferSelect): FundingParams | null {
  if (!c.escrowContract || !c.escrowSalt || !c.endsAt || !c.termsHash) return null;
  return { contract: getAddress(c.escrowContract), usdc: CELO_USDC, salt: c.escrowSalt as Hex, agent: (c.agentAddress ?? ZERO_ADDRESS) as Address, deadline: toSeconds(c.endsAt),
    budgetMicro: p.baseMicro * p.slots, baseMicro: p.baseMicro, slots: p.slots, termsHash: c.termsHash as Hex, attribution: attributionSuffix(), campaignId: c.escrowCampaignId as Hex | null, owner: c.ownerAddress };
}

/**
 * Fixes the end date and the terms (and so their hash), then hands the browser what it needs to fund.
 * The dates move only while nothing can have been funded with them: before the first click, or once
 * the old end date is less than a day away.
 */
export async function prepareOpenFunding(db: DB, projectId: string, userId: string, programId: string, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  return locked(db, `open-fund:${programId}`, async db => {
    const { campaign, program } = await openByProgram(db, projectId, programId);
    if (!["draft", "funding"].includes(campaign.status)) throw new Error("This campaign's money is already set aside");
    const contract = c.contract();
    if (!contract) throw new Error("Campaign payments aren't switched on for this server yet.");
    const now = Date.now();
    // Already prepared and still well before its end: keep the exact terms the browser may have funded.
    if (campaign.status === "funding" && campaign.endsAt && campaign.endsAt.getTime() >= now + 86_400_000 && campaign.termsHash && lower(campaign.escrowContract) === lower(contract)) return fundingParams(campaign, program)!;
    const [project] = await db.select({ name: s.projects.name }).from(s.projects).where(eq(s.projects.id, projectId));
    const endsAt = new Date(Math.ceil((now + campaign.durationDays * 86_400_000) / 60_000) * 60_000);
    const termsText = openTermsText({ business: project.name, title: campaign.title, slug: campaign.slug, task: campaign.task, proofKind: campaign.proofKind as ProofKind,
      requiredText: campaign.requiredText, rewardMicro: program.baseMicro, people: program.slots, endsAt });
    const agent = c.agent();
    const [updated] = await db.update(s.openCampaigns).set({ status: "funding", endsAt, termsText, termsVersion: OPEN_TERMS_VERSION, termsHash: openTermsHash(termsText),
      escrowContract: contract, escrowSalt: openSalt(projectId, campaign.id), agentAddress: agent, updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id)).returning();
    await db.update(s.experiments).set({ endsAt, updatedAt: new Date() }).where(eq(s.experiments.id, program.experimentId));
    if (campaign.status === "draft") await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.prepare_funding", target: campaign.id, data: { endsAt: endsAt.toISOString(), termsHash: updated.termsHash, agent } });
    return fundingParams(updated, program)!;
  });
}

/** Marks the campaign open only after Celo shows money set aside under exactly these terms. */
export async function confirmOpenFunding(db: DB, projectId: string, userId: string, programId: string, ownerInput: string, txHash: string | null, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  if (!isAddress(ownerInput)) throw new Error("That isn't a wallet address");
  const owner = getAddress(ownerInput);
  const { campaign, program } = await openByProgram(db, projectId, programId);
  if (campaign.status === "live" && lower(campaign.ownerAddress) === lower(owner)) return campaign.escrowCampaignId!;
  if (campaign.status !== "funding") throw new Error("Prepare the campaign for funding first");
  const params = fundingParams(campaign, program)!;
  const key = openCampaignKey(owner, params.salt);
  const onchain = await c.readCampaign(params.contract, key);
  if (lower(onchain.owner) !== lower(owner)) throw new Error("We can't see the money on Celo yet. Wait a few seconds and try again.");
  const matches = onchain.deadline === BigInt(params.deadline) && onchain.base === BigInt(params.baseMicro) && onchain.qualityBonus === 0n && onchain.outcomeBonus === 0n &&
    onchain.outcomeCap === 0n && onchain.slots === BigInt(params.slots) && lower(onchain.termsHash) === lower(params.termsHash) && lower(onchain.agent) === lower(params.agent);
  if (!matches) throw new Error("The campaign on Celo has different terms from this one, so we can't open it. Contact support before moving more money.");
  return locked(db, `open-fund:${programId}`, async db => {
    const [done] = await db.update(s.openCampaigns).set({ status: "live", escrowCampaignId: key, ownerAddress: owner.toLowerCase(), fundedAt: new Date(),
      fundingTx: txHash && /^0x[0-9a-f]{64}$/i.test(txHash) ? txHash.toLowerCase() : null, updatedAt: new Date() })
      .where(and(eq(s.openCampaigns.id, campaign.id), eq(s.openCampaigns.status, "funding"))).returning({ id: s.openCampaigns.id });
    if (!done) throw new Error("This campaign changed while we checked. Reload the page.");
    await db.update(s.creatorPrograms).set({ escrowCampaignId: key, escrowOwner: owner.toLowerCase(), escrowContract: params.contract.toLowerCase() }).where(eq(s.creatorPrograms.id, program.id));
    await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.funded", target: campaign.id, data: { owner, campaignId: key, txHash, budgetMicro: params.budgetMicro } });
    return key;
  });
}

// ───────────────────────────── participants ─────────────────────────────

function joinable(row: NonNullable<Awaited<ReturnType<typeof openBySlug>>>) {
  const c = row.campaign;
  if (c.status !== "live" || !c.endsAt || c.endsAt <= new Date() || !c.termsHash || !c.escrowCampaignId) throw new Error("This campaign isn't taking new people right now");
  return c;
}
async function refuseInsiders(db: DB, userId: string, projectId: string) {
  const [project] = await db.select({ ownerId: s.projects.ownerId }).from(s.projects).where(eq(s.projects.id, projectId));
  const [member] = await db.select({ id: s.memberships.id }).from(s.memberships).where(and(eq(s.memberships.projectId, projectId), eq(s.memberships.userId, userId)));
  if (project?.ownerId === userId || member) throw new Error("People on this business's team can't join its own campaign");
}
function checkPayout(address: string, c: typeof s.openCampaigns.$inferSelect) {
  if (!isPayableAddress(address)) throw new Error("Connect a wallet that can receive USDC on Celo");
  if ([lower(c.ownerAddress), lower(c.agentAddress)].includes(lower(address))) throw new Error("This wallet belongs to the business, so it can't receive a reward");
}

/** The exact message to sign. Built here, rebuilt on join, so nobody can sign different words. */
export async function openAgreementFor(db: DB, userId: string, slug: string, address: string) {
  const row = await openBySlug(db, slug);
  if (!row) throw new Error("Campaign not found");
  const c = joinable(row);
  await refuseInsiders(db, userId, c.projectId);
  checkPayout(address, c);
  const issuedAt = new Date().toISOString();
  return { issuedAt, message: agreementMessage({ title: c.title, business: row.business, slug: c.slug, termsHash: c.termsHash!, address, userId, issuedAt }) };
}

export async function joinOpenCampaign(db: DB, userId: string, slug: string, input: { address: string; issuedAt: string; signature: string }, chain?: OpenChain) {
  const ch = chain ?? await liveChain();
  const row = await openBySlug(db, slug);
  if (!row) throw new Error("Campaign not found");
  const c = joinable(row);
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!user?.emailVerifiedAt) throw new Error("Confirm your email first");
  await refuseInsiders(db, userId, c.projectId);
  checkPayout(input.address, c);
  const issued = new Date(input.issuedAt);
  if (!Number.isFinite(issued.getTime()) || issued.toISOString() !== input.issuedAt || Date.now() - issued.getTime() > AGREEMENT_MAX_AGE_MS || issued.getTime() - Date.now() > 60_000)
    throw new Error("The signature has expired. Sign again.");
  if (!/^0x[0-9a-f]+$/i.test(input.signature) || input.signature.length > 30_000) throw new Error("That signature isn't valid");
  const message = agreementMessage({ title: c.title, business: row.business, slug: c.slug, termsHash: c.termsHash!, address: input.address, userId, issuedAt: input.issuedAt });
  if (!await ch.verifyMessage(getAddress(input.address), message, input.signature as Hex)) throw new Error("The signature doesn't match this wallet. Sign again with the same wallet.");
  const address = input.address.toLowerCase();
  return locked(db, `open:${c.id}`, async db => {
    const [mine] = await db.select().from(s.openParticipants).where(and(eq(s.openParticipants.openCampaignId, c.id), eq(s.openParticipants.userId, userId)));
    if (mine) { if (mine.payoutAddress === address) return mine.id; throw new Error("You've already joined this campaign with another wallet"); }
    const [wallet] = await db.select({ id: s.openParticipants.id }).from(s.openParticipants).where(and(eq(s.openParticipants.openCampaignId, c.id), eq(s.openParticipants.payoutAddress, address)));
    if (wallet) throw new Error("Someone has already joined this campaign with this wallet");
    if (await takenSpots(db, c.id) >= row.program.slots) throw new Error("All spots in this campaign are taken");
    const campaignId = newId(), participantId = newId();
    const destination = (() => { try { return publicLink(row.website ?? ""); } catch { return `${(process.env.APP_URL || "https://celo.growtendril.xyz").replace(/\/$/, "")}/join/${c.slug}`; } })();
    await db.insert(s.campaigns).values({ id: campaignId, experimentId: row.program.experimentId, kolId: null, name: `${c.title}: ${user.name}`, channel: c.proofKind,
      utmSource: c.proofKind, utmMedium: "open_campaign", utmCampaign: c.programId, referralCode: shortCode(10), destinationUrl: destination });
    await db.insert(s.openParticipants).values({ id: participantId, openCampaignId: c.id, userId, campaignId, code: participantCode(), payoutAddress: address });
    await db.insert(s.openAgreements).values({ id: newId(), openCampaignId: c.id, participantId, userId, address, termsHash: c.termsHash!, termsVersion: c.termsVersion ?? OPEN_TERMS_VERSION,
      message, signature: input.signature, signedAt: issued });
    await audit(db, { projectId: c.projectId, actorType: "user", actorId: userId, action: "open_campaign.join", target: participantId, data: { openCampaignId: c.id, address, termsHash: c.termsHash } });
    return participantId;
  });
}

export async function submitOpenClaim(db: DB, userId: string, participantId: string, proofInput: string, read?: ProofReader) {
  const [row] = await db.select({ participant: s.openParticipants, campaign: s.openCampaigns }).from(s.openParticipants)
    .innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openParticipants.openCampaignId))
    .where(and(eq(s.openParticipants.id, participantId), eq(s.openParticipants.userId, userId)));
  if (!row) throw new Error("Join the campaign first");
  const c = row.campaign;
  if (c.status !== "live" || !c.endsAt || c.endsAt <= new Date()) throw new Error("This campaign has stopped taking proof");
  const proofUrl = publicLink(proofInput);
  const host = new URL(proofUrl).hostname.toLowerCase(), kind = c.proofKind as ProofKind;
  if (kind !== "link" && !PROOF_HOSTS[kind].test(host)) throw new Error(`Send the link to ${PROOF_LABEL[kind].toLowerCase()}`);
  const claimId = await locked(db, `open:${c.id}`, async db => {
    const [dup] = await db.select({ id: s.openClaims.id, participant: s.openClaims.participantId }).from(s.openClaims).where(and(eq(s.openClaims.openCampaignId, c.id), eq(s.openClaims.proofUrl, proofUrl)));
    if (dup && dup.participant !== participantId) throw new Error("Someone else already sent this link");
    const [existing] = await db.select().from(s.openClaims).where(eq(s.openClaims.participantId, participantId));
    if (!existing) {
      const id = newId();
      await db.insert(s.openClaims).values({ id, openCampaignId: c.id, participantId, proofUrl, rewardId: openRewardId(c.id, participantId) });
      return id;
    }
    if (existing.status !== "rejected" || existing.decidedBy !== "auto") throw new Error("You've already sent your proof");
    if (existing.attempts >= MAX_CLAIM_TRIES) throw new Error(`You've used all ${MAX_CLAIM_TRIES} tries`);
    await db.update(s.openClaims).set({ proofUrl, status: "checking", attempts: existing.attempts + 1, checks: [], rejectReason: null, decidedBy: null, decidedAt: null, author: null, proofTextHash: null, updatedAt: new Date() })
      .where(eq(s.openClaims.id, existing.id));
    return existing.id;
  });
  await audit(db, { projectId: c.projectId, actorType: "user", actorId: userId, action: "open_campaign.claim", target: claimId, data: { proofUrl } });
  // Checked now for a quick answer; the background job retries any claim still "checking".
  await checkOpenClaim(db, claimId, read).catch(() => null);
  return claimId;
}

// ───────────────────────────── owner: decide ─────────────────────────────

async function ownerClaim(db: DB, projectId: string, programId: string, claimId: string) {
  const { campaign, program } = await openByProgram(db, projectId, programId);
  const [claim] = await db.select().from(s.openClaims).where(and(eq(s.openClaims.id, claimId), eq(s.openClaims.openCampaignId, campaign.id)));
  if (!claim) throw new Error("Claim not found");
  return { campaign, program, claim };
}

export async function approveOpenClaim(db: DB, projectId: string, userId: string, programId: string, claimId: string) {
  const { campaign, program, claim } = await ownerClaim(db, projectId, programId, claimId);
  if (claim.status !== "needs_owner") throw new Error("This claim isn't waiting for you");
  if (!["live", "ended"].includes(campaign.status) || !campaign.endsAt || reviewEndsAt(campaign.endsAt) <= new Date()) throw new Error("Rewards in this campaign can no longer be approved");
  return locked(db, `open:${campaign.id}`, async db => {
    if (await takenSpots(db, campaign.id) >= program.slots) throw new Error("All spots are taken. Object to another reward first to free a spot.");
    const [done] = await db.update(s.openClaims).set({ status: "approved_waiting", decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, "needs_owner"))).returning({ id: s.openClaims.id });
    if (!done) throw new Error("This claim changed. Reload the page.");
    await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.approve", target: claim.id });
  });
}

/** Turning down a claim that hasn't reached Celo yet. Final: the person can't send it again. */
export async function rejectOpenClaim(db: DB, projectId: string, userId: string, programId: string, claimId: string, reasonInput: string) {
  const reason = reasonInput.trim().slice(0, 300);
  if (reason.length < 5) throw new Error("Tell the person why, in a few words");
  const { claim } = await ownerClaim(db, projectId, programId, claimId);
  const target = claim.status === "approved_waiting" ? "objected" : "rejected";
  const [done] = await db.update(s.openClaims).set(target === "objected"
    ? { status: "objected", objectionReason: reason, objectedAt: new Date(), decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() }
    : { status: "rejected", rejectReason: reason, attempts: MAX_CLAIM_TRIES, decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(s.openClaims.id, claim.id), inArray(s.openClaims.status, ["needs_owner", "approved_waiting"]))).returning({ id: s.openClaims.id });
  if (!done) throw new Error(claim.status === "queueing" ? "This reward is being set aside on Celo right now. Wait a minute, then object." : "This claim can't be turned down any more");
  await audit(db, { projectId, actorType: "user", actorId: userId, action: target === "objected" ? "open_campaign.object" : "open_campaign.reject", target: claim.id, data: { reason } });
}

/** After the owner's wallet sent `object`, record it once Celo shows the reward as objected. */
export async function confirmOpenObjection(db: DB, projectId: string, userId: string, programId: string, claimId: string, reason: string, txHash: string | null, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  const { campaign, claim } = await ownerClaim(db, projectId, programId, claimId);
  const reward = await c.readReward(getAddress(campaign.escrowContract!), campaign.escrowCampaignId as Hex, claim.rewardId as Hex);
  if (reward.status !== "Objected") throw new Error("Celo doesn't show the objection yet. Wait a few seconds and try again.");
  await db.update(s.openClaims).set({ status: "objected", objectionReason: reason.trim().slice(0, 300) || "The business objected", objectTx: txHash && /^0x[0-9a-f]{64}$/i.test(txHash) ? txHash : null, objectedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(s.openClaims.id, claim.id), inArray(s.openClaims.status, ["approved_queued", "queueing"])));
  await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.object", target: claim.id, data: { txHash, reason } });
}

/** Syncs a claim with what Celo says (owner queued it from their wallet, someone collected it, or it was objected). */
export async function syncOpenClaim(db: DB, claimId: string, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  const [row] = await db.select({ claim: s.openClaims, campaign: s.openCampaigns }).from(s.openClaims).innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openClaims.openCampaignId)).where(eq(s.openClaims.id, claimId));
  if (!row?.campaign.escrowCampaignId || !row.campaign.escrowContract) return null;
  const reward = await c.readReward(getAddress(row.campaign.escrowContract), row.campaign.escrowCampaignId as Hex, row.claim.rewardId as Hex);
  await applyRewardState(db, row.claim, reward);
  return reward.status;
}

/** Moves a claim to match its reward on Celo. Celo is the source of truth for money. Returns the new status. */
export async function applyRewardState(db: DB, claim: typeof s.openClaims.$inferSelect, reward: OnchainReward, now = new Date()): Promise<string> {
  const where = and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, claim.status));
  if (reward.status === "Held" && ["approved_waiting", "queueing", "needs_owner"].includes(claim.status)) {
    await db.update(s.openClaims).set({ status: "approved_queued", amountMicro: Number(reward.amount), evidenceHash: reward.evidenceHash, claimableAt: new Date(Number(reward.claimableAt) * 1000), queuedAt: claim.queuedAt ?? now, queueError: null, updatedAt: now }).where(where);
    return "approved_queued";
  }
  if (reward.status === "Paid" && claim.status !== "paid") {
    await db.update(s.openClaims).set({ status: "paid", amountMicro: Number(reward.amount), paidAt: claim.paidAt ?? now, updatedAt: now }).where(where);
    return "paid";
  }
  if (reward.status === "Objected" && claim.status !== "objected") {
    await db.update(s.openClaims).set({ status: "objected", objectionReason: claim.objectionReason ?? "The business objected", objectedAt: claim.objectedAt ?? now, updatedAt: now }).where(where);
    return "objected";
  }
  if (reward.status === "None" && claim.status === "queueing") {
    await db.update(s.openClaims).set({ status: "approved_waiting", updatedAt: now }).where(where);
    return "approved_waiting";
  }
  return claim.status;
}

export async function setOpenAutoApprove(db: DB, projectId: string, userId: string, programId: string, on: boolean) {
  const { campaign } = await openByProgram(db, projectId, programId);
  await db.update(s.openCampaigns).set({ autoApprove: on, updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id));
  await audit(db, { projectId, actorType: "user", actorId: userId, action: on ? "open_campaign.auto_on" : "open_campaign.auto_off", target: campaign.id });
}

/** After the owner's wallet changed the campaign's agent (usually removing GrowTendril), mirror Celo. */
export async function confirmOpenAgent(db: DB, projectId: string, userId: string, programId: string, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  const { campaign } = await openByProgram(db, projectId, programId);
  if (!campaign.escrowCampaignId || !campaign.escrowContract) throw new Error("This campaign isn't funded yet");
  const onchain = await c.readCampaign(getAddress(campaign.escrowContract), campaign.escrowCampaignId as Hex);
  const agent = lower(onchain.agent) === lower(ZERO_ADDRESS) ? null : onchain.agent.toLowerCase();
  await db.update(s.openCampaigns).set({ agentAddress: agent, ...(agent ? {} : { autoApprove: false }), updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id));
  await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.agent_changed", target: campaign.id, data: { agent } });
  return agent;
}

/** Stops new people and new proof now. Rewards already approved still finish. */
export async function endOpenCampaign(db: DB, projectId: string, userId: string, programId: string) {
  const { campaign, program } = await openByProgram(db, projectId, programId);
  if (campaign.status === "draft" || campaign.status === "funding") {
    await db.update(s.openCampaigns).set({ status: "closed", updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id));
    await db.update(s.experiments).set({ status: "stopped", updatedAt: new Date(), outcome: { verdict: "CLOSED", reason: "Closed before any money was set aside" } }).where(eq(s.experiments.id, program.experimentId));
  } else if (campaign.status === "live") {
    await db.update(s.openCampaigns).set({ status: "ended", updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id));
  } else throw new Error("This campaign has already ended");
  await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.end", target: campaign.id, data: { from: campaign.status } });
}

/** After the owner's wallet took back the unused money, close the campaign once Celo shows nothing left unused. */
export async function confirmOpenRefund(db: DB, projectId: string, userId: string, programId: string, txHash: string | null, chain?: OpenChain) {
  const c = chain ?? await liveChain();
  const { campaign, program } = await openByProgram(db, projectId, programId);
  if (!campaign.escrowCampaignId || !campaign.escrowContract || !campaign.endsAt) throw new Error("This campaign isn't funded");
  if (reviewEndsAt(campaign.endsAt) > new Date()) throw new Error(`Unused money can be taken back from ${reviewEndsAt(campaign.endsAt).toISOString().slice(0, 10)}`);
  const onchain = await c.readCampaign(getAddress(campaign.escrowContract), campaign.escrowCampaignId as Hex);
  if (onchain.available !== 0n) throw new Error("Celo still shows unused money in the campaign. Wait a few seconds and try again.");
  const open = await db.select({ id: s.openClaims.id }).from(s.openClaims).where(and(eq(s.openClaims.openCampaignId, campaign.id), inArray(s.openClaims.status, ["approved_queued", "queueing"])));
  await db.update(s.openCampaigns).set({ status: open.length ? "ended" : "closed", refundTx: txHash && /^0x[0-9a-f]{64}$/i.test(txHash) ? txHash : null, refundedAt: new Date(), updatedAt: new Date() }).where(eq(s.openCampaigns.id, campaign.id));
  if (!open.length) await db.update(s.experiments).set({ status: "stopped", updatedAt: new Date(), outcome: { verdict: "CLOSED", reason: "Campaign finished and unused money returned" } }).where(eq(s.experiments.id, program.experimentId));
  await audit(db, { projectId, actorType: "user", actorId: userId, action: "open_campaign.refund", target: campaign.id, data: { txHash } });
}

/** Claims still waiting for the owner, across every open campaign in a workspace. */
export async function openClaimsNeedingOwner(db: DB, projectId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.openClaims).innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openClaims.openCampaignId))
    .where(and(eq(s.openCampaigns.projectId, projectId), eq(s.openClaims.status, "needs_owner")));
  return n;
}
