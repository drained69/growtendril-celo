/**
 * Open reward campaigns: anyone with the link can join, agree to plain terms, do a task and get paid
 * from CampaignEscrow on Celo. Client-safe: no server imports, so pages and the browser share one
 * definition of the terms, the hashes and the contract interface.
 */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { fmtUsdc, microToDecimal, toMicro } from "@/lib/money";

export const PROOF_KINDS = ["x", "bluesky", "youtube", "tiktok", "link"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];
export const PROOF_LABEL: Record<ProofKind, string> = {
  x: "A post on X",
  bluesky: "A post on Bluesky",
  youtube: "A YouTube video",
  tiktok: "A TikTok video",
  link: "Any public web page (a blog post, a review, a listing)",
};
/** The same, mid-sentence. */
export const PROOF_NOUN: Record<ProofKind, string> = { x: "a post on X", bluesky: "a post on Bluesky", youtube: "a YouTube video", tiktok: "a TikTok video", link: "a public web page" };
/** Where a proof link of each kind may point. `link` accepts any public page. */
export const PROOF_HOSTS: Record<Exclude<ProofKind, "link">, RegExp> = {
  x: /^((www|mobile)\.)?(x|twitter)\.com$/,
  bluesky: /^bsky\.app$/,
  youtube: /^((www|m)\.)?youtube\.com$|^youtu\.be$/,
  tiktok: /^((www|m|vm)\.)?tiktok\.com$/,
};

/** Caps while the contract is unaudited. */
export const OPEN_LIMITS = { minRewardMicro: 10_000, maxRewardMicro: 50_000_000, maxTotalMicro: 500_000_000, maxPeople: 500, maxDays: 31 } as const;
/** CampaignEscrow's fixed hold (72 h) and review window (7 days after the deadline). */
export const OPEN_HOLD_SECONDS = 259_200;
export const OPEN_REVIEW_WINDOW_SECONDS = 604_800;
/** After the hold, the person has this long to collect the reward from their own wallet before GrowTendril sends it. */
export const COLLECT_WINDOW_MS = 24 * 3_600_000;
export const OPEN_TERMS_VERSION = "open-1";
export const MAX_CLAIM_TRIES = 3;
/** How long a signed agreement stays valid between signing and joining. */
export const AGREEMENT_MAX_AGE_MS = 15 * 60_000;

const usdc = z.string().trim().max(32).regex(/^\d+(\.\d{1,6})?$/, "Enter an amount like 2 or 2.50").transform((v, ctx) => {
  try { return toMicro(v); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
});

export const OpenCampaignInput = z.object({
  title: z.string().trim().min(3, "Give the campaign a name of at least 3 characters").max(80),
  task: z.string().trim().min(20, "Describe what people should do in at least 20 characters").max(1500),
  proofKind: z.enum(PROOF_KINDS),
  requiredText: z.string().trim().max(40, "Keep the required words under 40 characters").regex(/^[^\r\n]*$/, "Required words must be on one line").optional().transform(v => v || null),
  reward: usdc,
  people: z.coerce.number().int().min(1, "At least 1 person").max(OPEN_LIMITS.maxPeople, `At most ${OPEN_LIMITS.maxPeople} people for now`),
  days: z.coerce.number().int().min(1, "At least 1 day").max(OPEN_LIMITS.maxDays, `At most ${OPEN_LIMITS.maxDays} days`),
});
export type OpenCampaignTerms = z.infer<typeof OpenCampaignInput>;

/** What the owner sets aside: one fixed reward per person, for every spot. */
export function openEconomics(v: { reward: number; people: number }) {
  const totalMicro = v.reward * v.people;
  if (!Number.isSafeInteger(v.reward) || !Number.isSafeInteger(totalMicro) || v.reward <= 0) throw new Error("Enter a reward above $0");
  if (v.reward < OPEN_LIMITS.minRewardMicro) throw new Error(`The reward must be at least ${fmtUsdc(OPEN_LIMITS.minRewardMicro)}`);
  if (v.reward > OPEN_LIMITS.maxRewardMicro) throw new Error(`For now a reward can be at most ${fmtUsdc(OPEN_LIMITS.maxRewardMicro)} per person`);
  if (totalMicro > OPEN_LIMITS.maxTotalMicro) throw new Error(`For now a campaign can set aside at most ${fmtUsdc(OPEN_LIMITS.maxTotalMicro)}. Lower the reward or the number of people.`);
  return { perPersonMicro: v.reward, totalMicro };
}

export interface OpenTermsFields {
  business: string; title: string; slug: string; task: string; proofKind: ProofKind; requiredText: string | null;
  rewardMicro: number; people: number; endsAt: Date;
}
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const usd = (micro: number) => `${microToDecimal(micro)} USDC`;

/** The exact words a participant agrees to. Their hash is stored in the contract, so they can never change. */
export function openTermsText(t: OpenTermsFields): string {
  const words = t.requiredText ? ` and the words "${t.requiredText}"` : "";
  return [
    `GrowTendril open campaign terms (${OPEN_TERMS_VERSION})`,
    `Business: ${t.business}`,
    `Campaign: ${t.title}`,
    `Campaign page: /join/${t.slug}`,
    ``,
    `What to do: ${t.task}`,
    `How to prove it: ${PROOF_LABEL[t.proofKind]} that shows your personal code or your personal link${words}. Send the link before ${utc(t.endsAt)}.`,
    `Reward: ${usd(t.rewardMicro)} per person (USDC is a digital dollar: 1 USDC = $1), for up to ${t.people} ${t.people === 1 ? "person" : "people"}. One reward per person and per wallet.`,
    `The money: ${usd(t.rewardMicro * t.people)} is set aside in a contract on the Celo network before anyone can join. It can only go to approved people, or back to the business after the campaign.`,
    `Approval: GrowTendril checks each claim, and the business can check it too. After a reward is approved, the business has 3 days to object. After those 3 days you can collect the reward yourself; if you don't, it is sent to your wallet automatically within a day.`,
    `Unused money goes back to the business 7 days after the campaign ends.`,
  ].join("\n");
}
export const openTermsHash = (text: string): Hex => keccak256(toHex(text));

/** The plain message a participant signs with their payout wallet. Signing is free and moves no money. */
export function agreementMessage(a: { title: string; business: string; slug: string; termsHash: string; address: string; userId: string; issuedAt: string }) {
  return [
    `I agree to the terms of "${a.title}" by ${a.business} on GrowTendril.`,
    `Campaign: ${a.slug}`,
    `Terms: ${a.termsHash}`,
    `Pay me at: ${a.address.toLowerCase()}`,
    `Account: ${a.userId}`,
    `Signed at: ${a.issuedAt}`,
    `Signing this is free and does not move any money.`,
  ].join("\n");
}

// ── CampaignEscrow (contracts/src/CampaignEscrow.sol, deployed on Celo mainnet) ──
export { CAMPAIGN_ESCROW_ABI, isCampaignEscrowCode } from "@growth-tools/campaign-escrow";
export const REWARD_STATUS = ["None", "Held", "Paid", "Objected"] as const;
export type RewardStatus = (typeof REWARD_STATUS)[number];
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;

export interface OnchainCampaign { owner: Address; agent: Address; deadline: bigint; available: bigint; reserved: bigint; base: bigint; qualityBonus: bigint; outcomeBonus: bigint; outcomeCap: bigint; slots: bigint; queued: bigint; termsHash: Hex }
export interface OnchainReward { recipient: Address; amount: bigint; claimableAt: bigint; evidenceHash: Hex; status: RewardStatus }

export const openSalt = (projectId: string, openCampaignId: string): Hex => keccak256(toHex(`growtendril:open:${projectId}:${openCampaignId}`));
export const openCampaignKey = (owner: Address, salt: Hex): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [owner, salt]));
/** Fixed per participant, so a retried queue can never pay one person twice. */
export const openRewardId = (openCampaignId: string, participantId: string): Hex => keccak256(toHex(`growtendril:open:${openCampaignId}:${participantId}`));
export const openReasonHash = (reason: string): Hex => keccak256(toHex(reason.trim() || "objected"));
export const openEvidenceHash = (e: { claimId: string; proofUrl: string; proofTextHash: string | null; decidedBy: string | null }): Hex =>
  keccak256(toHex(JSON.stringify([e.claimId, e.proofUrl, e.proofTextHash ?? "", e.decidedBy ?? ""])));

// ── Plain status words ──
export type OpenCampaignStatus = "draft" | "funding" | "live" | "ended" | "closed";
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Money not set aside yet",
  funding: "Waiting for the money",
  live: "Open",
  ended: "Ended, finishing payouts",
  closed: "Closed",
};
export type OpenClaimStatus = "checking" | "needs_owner" | "rejected" | "approved_waiting" | "queueing" | "approved_queued" | "objected" | "paid";
/** Claims that hold one of the campaign's spots. */
export const SPOT_TAKING: OpenClaimStatus[] = ["approved_waiting", "queueing", "approved_queued", "paid"];
export const CLAIM_STATUS_LABEL: Record<string, string> = {
  checking: "Checking",
  needs_owner: "Needs you",
  rejected: "Turned down",
  approved_waiting: "Approved, setting the reward aside",
  queueing: "Approved, setting the reward aside",
  approved_queued: "Approved, paying after the 3-day hold",
  objected: "You objected",
  paid: "Paid",
};
export const CLAIM_STATUS_FOR_PARTICIPANT: Record<string, string> = {
  checking: "We're checking your proof",
  needs_owner: "The business is checking your proof",
  rejected: "Not accepted",
  approved_waiting: "Approved, getting your reward ready",
  queueing: "Approved, getting your reward ready",
  approved_queued: "Approved, ready after the 3-day hold",
  objected: "The business objected, so this reward won't be paid",
  paid: "Paid to your wallet",
};
export const CLAIM_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = {
  checking: "info", needs_owner: "warn", rejected: "bad", approved_waiting: "info", queueing: "info", approved_queued: "info", objected: "bad", paid: "good",
};

export function slugify(title: string) {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "campaign";
}
export const SLUG_RE = /^[a-z0-9-]{3,64}$/;
export const PARTICIPANT_CODE_RE = /^GT-[A-HJ-NP-Z2-9]{6}$/;
