import { eq, sql } from "drizzle-orm";
import { keccak256, toHex } from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import * as s from "@/server/db/schema";
import { canonical } from "@arc-growth/evidence";
import { calculateReward } from "@arc-growth/outcomes";

import type { DB } from "@/server/db/client";
import { programById, campaignParticipants, qualifiedOutcomes } from "@/server/domain/growth/creator-campaigns";
import { escrowAddress, escrowSalt } from "@/server/integrations/celo/escrow";

export async function escrowPreview(db:DB,projectId:string,programId:string) {
  const {program,experiment}=await programById(db,projectId,programId);
  const [members,outcomes]=await Promise.all([campaignParticipants(db,programId),qualifiedOutcomes(db,programId)]);
  const terms={salt:escrowSalt(projectId,programId),campaignId:program.escrowCampaignId,owner:program.escrowOwner,termsHash:keccak256(toHex(canonical({brief:program.brief,base:program.baseMicro,qualityBonus:program.qualityBonusMicro,outcomeBonus:program.outcomeBonusMicro,outcomeCap:program.outcomeCap,slots:program.slots,deadline:experiment.endsAt?.toISOString()}))),budgetMicro:experiment.budgetMicro,deadline:Math.floor(experiment.endsAt!.getTime()/1000),baseMicro:program.baseMicro,qualityBonusMicro:program.qualityBonusMicro,outcomeBonusMicro:program.outcomeBonusMicro,outcomeCap:program.outcomeCap,slots:program.slots};
  // A reward already paid through the approval flow can never be queued in escrow as well.
  const paid=new Set((await db.select({contribution:sql<string|null>`${s.agentDecisions.action}->>'contributionId'`,state:s.transactions.state}).from(s.transactions).innerJoin(s.agentDecisions,eq(s.agentDecisions.id,s.transactions.decisionId)).where(eq(s.transactions.projectId,projectId))).filter(t=>t.contribution&&!["FAILED","DENIED","REJECTED"].includes(t.state)).map(t=>t.contribution));
  const rewards=members.filter(m=>m.contribution?.status==="accepted"&&m.participant.status==="verified"&&m.participant.payoutAddress&&!paid.has(m.contribution.id)).map(m=>{
    const post=m.contribution!, events=outcomes.filter(o=>o.participant===m.participant.id), count=Math.min(events.length,program.outcomeCap), reward=calculateReward(program,post.score??0,count);
    return {id:post.id,recipient:m.participant.payoutAddress!,score:post.score??0,outcomes:count,amountMicro:reward.totalMicro,evidenceHash:keccak256(toHex(canonical({postId:post.id,score:post.score,outcomeIds:events.map(e=>e.event.id),dataMode:"LIVE"})))};
  });
  const code=process.env.CELO_ATTRIBUTION_CODE;
  return {programId,terms,rewards,contract:escrowAddress() as string|null,attribution:code&&/^[a-z0-9_]{1,32}$/.test(code)?toDataSuffix(code) as `0x${string}`:null,title:experiment.title};
}
