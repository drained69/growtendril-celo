import { getAddress, isAddress, type Address, type Hex } from "viem";
import { CAMPAIGN_ESCROW_ABI, OPEN_HOLD_SECONDS, OPEN_REVIEW_WINDOW_SECONDS, REWARD_STATUS, type OnchainCampaign, type OnchainReward } from "@/lib/open-campaigns";
import { operatorAccount, operatorProblem, operatorWalletClient, publicClient } from "./client";
import { CELO } from "./config";

export { CAMPAIGN_ESCROW_ABI };

/** The deployed CampaignEscrow. Unset means open campaigns can't be funded; no other address is ever assumed. */
export function campaignEscrowAddress(): Address | null {
  const value = process.env.CELO_CAMPAIGN_ESCROW?.trim();
  return value && isAddress(value) ? getAddress(value) : null;
}

/** GrowTendril's agent for open campaigns: the shared protocol operator, or null when it can't sign. */
export function openAgentAddress(): Address | null {
  return operatorProblem() ? null : operatorAccount().address;
}

const verified = new Map<string, Promise<void>>();
/**
 * Interim code check until the reviewed runtime hash ships on main: the address must hold code that
 * answers like CampaignEscrow, with Celo USDC, a 72-hour hold and a 7-day review window.
 */
export function assertCampaignEscrow(contract: Address): Promise<void> {
  const key = contract.toLowerCase();
  if (!verified.has(key)) {
    const check = (async () => {
      const client = publicClient();
      const code = await client.getCode({ address: contract });
      if (!code || code === "0x") throw new Error("There is no campaign contract at the configured address");
      const [token, hold, window] = await Promise.all([
        client.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "token" }),
        client.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "refundHold" }),
        client.readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "REVIEW_WINDOW" }),
      ]);
      if (token.toLowerCase() !== CELO.usdc.toLowerCase() || hold !== BigInt(OPEN_HOLD_SECONDS) || window !== BigInt(OPEN_REVIEW_WINDOW_SECONDS)) {
        throw new Error("The configured campaign contract must use Celo USDC, a 3-day hold and a 7-day review window");
      }
    })();
    verified.set(key, check);
    check.catch(() => verified.delete(key));
  }
  return verified.get(key)!;
}

export async function readOpenCampaign(contract: Address, campaignId: Hex): Promise<OnchainCampaign> {
  await assertCampaignEscrow(contract);
  const [owner, agent, deadline, available, reserved, base, qualityBonus, outcomeBonus, outcomeCap, slots, queued, termsHash] =
    await publicClient().readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "campaigns", args: [campaignId] });
  return { owner, agent, deadline, available, reserved, base, qualityBonus, outcomeBonus, outcomeCap, slots, queued, termsHash };
}

export async function readOpenReward(contract: Address, campaignId: Hex, rewardId: Hex): Promise<OnchainReward> {
  await assertCampaignEscrow(contract);
  const [recipient, amount, , , claimableAt, evidenceHash, status] =
    await publicClient().readContract({ address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "rewards", args: [campaignId, rewardId] });
  return { recipient, amount, claimableAt, evidenceHash, status: REWARD_STATUS[status] ?? "None" };
}

/** Simulates first (a refused queue costs nothing), then sends as the agent. The tx carries the attribution tag. */
export async function agentQueueReward(contract: Address, campaignId: Hex, rewardId: Hex, recipient: Address, evidenceHash: Hex): Promise<Hex> {
  await assertCampaignEscrow(contract);
  const account = operatorAccount();
  const { request } = await publicClient().simulateContract({ account, address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "queueReward", args: [campaignId, rewardId, recipient, 0n, 0n, evidenceHash] });
  return operatorWalletClient().writeContract(request);
}

/** `claim` is permissionless; the money always goes to the reward's own recipient. */
export async function agentRelayClaim(contract: Address, campaignId: Hex, rewardId: Hex): Promise<Hex> {
  await assertCampaignEscrow(contract);
  const account = operatorAccount();
  const { request } = await publicClient().simulateContract({ account, address: contract, abi: CAMPAIGN_ESCROW_ABI, functionName: "claim", args: [campaignId, rewardId] });
  return operatorWalletClient().writeContract(request);
}

/** True once Celo confirms the transaction succeeded; false if it reverted. Throws if it isn't mined in time. */
export async function waitForSuccess(hash: Hex): Promise<boolean> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 60_000 });
  return receipt.status === "success";
}
