import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { isOutcomeEscrowCode, OUTCOME_ESCROW_ABI } from "@arc-growth/escrow";
import { publicClient } from "./client";
import { CELO } from "./config";

export const ESCROW_HOLD_SECONDS = 259_200n;

/** The deployed mainnet contract. Unset means funding stays unavailable; no other address is ever assumed. */
export function escrowAddress(): Address | null {
  const value = process.env.CELO_REWARDS_ESCROW?.trim();
  return value && isAddress(value) ? getAddress(value) : null;
}
export const escrowSalt = (projectId: string, programId: string): Hex => keccak256(toHex(`growtendril:celo:${projectId}:${programId}`));
export const escrowCampaignId = (owner: Address, salt: Hex): Hex => keccak256(encodeAbiParameters([{type: "address"}, {type: "bytes32"}], [owner, salt]));

export interface EscrowTermsCheck {deadline: number; baseMicro: number; qualityBonusMicro: number; outcomeBonusMicro: number; outcomeCap: number; slots: number; termsHash: string}
export type EscrowCampaign = readonly [Address, Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, Hex];

/** Every term a creator relies on must match what GrowTendril shows them. */
export function campaignMatchesTerms(c: EscrowCampaign, owner: string, t: EscrowTermsCheck): boolean {
  const [campaignOwner, arbiter, deadline, , , base, qualityBonus, outcomeBonus, outcomeCap, slots, , termsHash] = c;
  return campaignOwner.toLowerCase() === owner.toLowerCase() && !/^0x0{40}$/i.test(arbiter) && arbiter.toLowerCase() !== owner.toLowerCase() &&
    deadline === BigInt(t.deadline) && base === BigInt(t.baseMicro) && qualityBonus === BigInt(t.qualityBonusMicro) &&
    outcomeBonus === BigInt(t.outcomeBonusMicro) && outcomeCap === BigInt(t.outcomeCap) && slots === BigInt(t.slots) &&
    termsHash.toLowerCase() === t.termsHash.toLowerCase();
}

export async function readFundedCampaign(contract: Address, owner: Address, salt: Hex): Promise<{campaignId: Hex; campaign: EscrowCampaign}> {
  const client = publicClient();
  const code = await client.getCode({address: contract});
  if (!code || !isOutcomeEscrowCode(code)) throw new Error("The configured escrow does not match the reviewed contract");
  const [token, hold] = await Promise.all([
    client.readContract({address: contract, abi: OUTCOME_ESCROW_ABI, functionName: "token"}),
    client.readContract({address: contract, abi: OUTCOME_ESCROW_ABI, functionName: "refundHold"}),
  ]);
  if (token.toLowerCase() !== CELO.usdc.toLowerCase() || hold !== ESCROW_HOLD_SECONDS) throw new Error("The configured escrow must use Celo USDC and a 72-hour refund hold");
  const campaignId = escrowCampaignId(owner, salt);
  const campaign = await client.readContract({address: contract, abi: OUTCOME_ESCROW_ABI, functionName: "campaigns", args: [campaignId]}) as unknown as EscrowCampaign;
  return {campaignId, campaign};
}
