import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { audit } from "@/server/db/helpers";
import { COLLECT_WINDOW_MS, openEvidenceHash, type OnchainCampaign, type OnchainReward } from "@/lib/open-campaigns";
import { applyRewardState, reviewEndsAt } from "@/server/domain/growth/open-campaigns";
import { tellParticipant } from "@/server/domain/growth/open-emails";
import { openException } from "@/server/domain/reconcile/exceptions";

/** What the job needs from Celo and the claim checker; injectable so tests never touch the chain. */
export interface EscrowAgent {
  agent(): Address | null;
  readCampaign(contract: Address, id: Hex): Promise<OnchainCampaign>;
  readReward(contract: Address, id: Hex, rewardId: Hex): Promise<OnchainReward>;
  queue(contract: Address, id: Hex, rewardId: Hex, recipient: Address, evidenceHash: Hex): Promise<Hex>;
  relay(contract: Address, id: Hex, rewardId: Hex): Promise<Hex>;
  wait(hash: Hex): Promise<boolean>;
  check(db: DB, claimId: string): Promise<unknown>;
}

export async function liveEscrowAgent(): Promise<EscrowAgent> {
  const e = await import("@/server/integrations/celo/campaign-escrow");
  const { checkOpenClaim } = await import("@/server/domain/growth/open-claim-check");
  return { agent: e.openAgentAddress, readCampaign: e.readOpenCampaign, readReward: e.readOpenReward, queue: e.agentQueueReward, relay: e.agentRelayClaim, wait: e.waitForSuccess, check: (db, id) => checkOpenClaim(db, id) };
}

const CHECK_RETRY_MS = 2 * 60_000;
/** A claim left "queueing" this long (a crash, a lost receipt) is settled by reading Celo. */
const STUCK_MS = 5 * 60_000;
const MAX_QUEUE_FAILURES = 5;
const lower = (a: string | null | undefined) => (a ?? "").toLowerCase();
const short = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 240);

/**
 * Runs every minute. Ends campaigns past their date, retries unfinished claim checks, sets approved
 * rewards aside on Celo as GrowTendril's agent, and sends each reward to its person a day after the
 * 3-day hold if they haven't collected it themselves. Reads each reward from Celo before acting, so
 * running it twice never pays anyone twice.
 */
export async function openEscrowTick(db: DB, agent?: EscrowAgent, now = new Date(), opts: { sweep?: boolean } = {}) {
  const a = agent ?? await liveEscrowAgent();
  const out = { ended: 0, checked: 0, queued: 0, paid: 0, synced: 0, alerts: 0, errors: [] as string[] };

  out.ended = (await db.update(s.openCampaigns).set({ status: "ended", updatedAt: now })
    .where(and(eq(s.openCampaigns.status, "live"), lt(s.openCampaigns.endsAt, now))).returning({ id: s.openCampaigns.id })).length;

  const checking = await db.select({ id: s.openClaims.id }).from(s.openClaims)
    .where(and(eq(s.openClaims.status, "checking"), lt(s.openClaims.updatedAt, new Date(now.getTime() - CHECK_RETRY_MS)))).orderBy(asc(s.openClaims.updatedAt)).limit(20);
  for (const c of checking) {
    try { await a.check(db, c.id); out.checked++; } catch (e) { out.errors.push(`check ${c.id}: ${short(e)}`); }
  }

  const rows = await db.select({ claim: s.openClaims, campaign: s.openCampaigns, to: s.openParticipants.payoutAddress }).from(s.openClaims)
    .innerJoin(s.openCampaigns, eq(s.openCampaigns.id, s.openClaims.openCampaignId))
    .innerJoin(s.openParticipants, eq(s.openParticipants.id, s.openClaims.participantId))
    .where(and(inArray(s.openClaims.status, ["approved_waiting", "queueing", "approved_queued"]), isNotNull(s.openCampaigns.escrowCampaignId), isNotNull(s.openCampaigns.escrowContract)))
    .orderBy(asc(s.openClaims.updatedAt)).limit(50);
  const campaigns = new Map<string, OnchainCampaign>();
  for (const { claim, campaign, to } of rows) {
    const contract = getAddress(campaign.escrowContract!), id = campaign.escrowCampaignId as Hex, rewardId = claim.rewardId as Hex;
    try {
      if (claim.status === "queueing") {
        if (now.getTime() - claim.updatedAt.getTime() < STUCK_MS) continue;
        await applyRewardState(db, claim, await a.readReward(contract, id, rewardId), now); out.synced++;
        continue;
      }
      if (claim.status === "approved_queued") {
        // The person gets a day after the hold to collect it from their own wallet; then GrowTendril sends it.
        if (!claim.claimableAt || claim.claimableAt.getTime() + COLLECT_WINDOW_MS > now.getTime()) continue;
        const reward = await a.readReward(contract, id, rewardId);
        if (reward.status !== "Held") { await applyRewardState(db, claim, reward, now); out.synced++; continue; }
        if (BigInt(Math.floor(now.getTime() / 1000)) < reward.claimableAt) continue;
        const hash = await a.relay(contract, id, rewardId);
        await db.update(s.openClaims).set({ payTx: hash, updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        if (await a.wait(hash)) {
          const paid = await db.update(s.openClaims).set({ status: "paid", paidAt: now, amountMicro: Number(reward.amount), updatedAt: now }).where(and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, "approved_queued"))).returning({ id: s.openClaims.id });
          await audit(db, { projectId: campaign.projectId, actorType: "agent", action: "open_campaign.paid", target: claim.id, data: { txHash: hash, amountMicro: Number(reward.amount), to } });
          if (paid.length) await tellParticipant(db, claim.id, "paid");
          out.paid++;
        }
        continue;
      }
      // approved_waiting: set the reward aside, unless Celo already has it (a retry after a lost receipt).
      const existing = await a.readReward(contract, id, rewardId);
      if (existing.status !== "None") { await applyRewardState(db, claim, existing, now); out.synced++; continue; }
      if (!campaign.endsAt || reviewEndsAt(campaign.endsAt) <= now) {
        if (!claim.queueError) await db.update(s.openClaims).set({ queueError: "The time to approve rewards in this campaign has passed", updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        continue;
      }
      const me = a.agent();
      if (!campaigns.has(id)) campaigns.set(id, await a.readCampaign(contract, id));
      if (!me || lower(campaigns.get(id)!.agent) !== lower(me)) {
        const note = "GrowTendril can't approve rewards in this campaign. Approve it from your wallet.";
        if (claim.queueError !== note) await db.update(s.openClaims).set({ queueError: note, updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        continue;
      }
      const [mine] = await db.update(s.openClaims).set({ status: "queueing", updatedAt: now }).where(and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, "approved_waiting"))).returning();
      if (!mine) continue;
      const evidence = openEvidenceHash({ claimId: claim.id, proofUrl: claim.proofUrl, proofTextHash: claim.proofTextHash, decidedBy: claim.decidedBy });
      let hash: Hex | null = null;
      try {
        hash = await a.queue(contract, id, rewardId, getAddress(to), evidence);
        await db.update(s.openClaims).set({ queueTx: hash, evidenceHash: evidence, updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        const ok = await a.wait(hash);
        const [fresh] = await db.select().from(s.openClaims).where(eq(s.openClaims.id, claim.id));
        const state = await applyRewardState(db, fresh, await a.readReward(contract, id, rewardId), now);
        if (state === "approved_queued") {
          out.queued++;
          await audit(db, { projectId: campaign.projectId, actorType: "agent", action: "open_campaign.queued", target: claim.id, data: { txHash: hash, to } });
        } else if (!ok) {
          await db.update(s.openClaims).set({ queueError: "The transaction didn't go through on Celo", queueFailures: claim.queueFailures + 1, updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        }
      } catch (e) {
        if (hash) {
          // Sent but not confirmed: stay "queueing"; the stuck check reads Celo in a few minutes.
          await db.update(s.openClaims).set({ queueError: short(e), updatedAt: now }).where(eq(s.openClaims.id, claim.id));
        } else {
          const failures = claim.queueFailures + 1;
          await db.update(s.openClaims).set({ status: failures >= MAX_QUEUE_FAILURES ? "needs_owner" : "approved_waiting", queueError: short(e), queueFailures: failures, updatedAt: now })
            .where(and(eq(s.openClaims.id, claim.id), eq(s.openClaims.status, "queueing")));
        }
        out.errors.push(`queue ${claim.id}: ${short(e)}`);
      }
    } catch (e) {
      out.errors.push(`${claim.status} ${claim.id}: ${short(e)}`);
    }
  }

  // Every 5 minutes: each reward on Celo must belong to a claim GrowTendril knows. More rewards than
  // that means someone with permission (the owner outside the app, or a stolen agent key) approved one.
  if (opts.sweep ?? now.getUTCMinutes() % 5 === 0) {
    const funded = await db.select().from(s.openCampaigns)
      .where(and(inArray(s.openCampaigns.status, ["live", "ended"]), isNotNull(s.openCampaigns.escrowCampaignId), isNotNull(s.openCampaigns.escrowContract)));
    for (const c of funded) {
      try {
        const id = c.escrowCampaignId as Hex;
        const onchain = campaigns.get(id) ?? await a.readCampaign(getAddress(c.escrowContract!), id);
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.openClaims)
          .where(and(eq(s.openClaims.openCampaignId, c.id), inArray(s.openClaims.status, ["approved_waiting", "queueing", "approved_queued", "paid"])));
        if (onchain.queued > BigInt(n)) {
          const opened = await openException(db, { scope: "wallet", projectId: c.projectId, kind: "unexpected_reward", ref: `${id}:${onchain.queued}`,
            detail: `Celo shows ${onchain.queued} approved rewards in the campaign "${c.title}", but GrowTendril approved only ${n}. Someone with permission approved a reward GrowTendril doesn't know about. If it wasn't you, open the campaign, remove GrowTendril's permission, and object to any reward you don't recognise before its 3-day hold ends.` });
          if (opened) out.alerts++;
        }
      } catch (e) {
        out.errors.push(`sweep ${c.id}: ${short(e)}`);
      }
    }
  }
  return out;
}
