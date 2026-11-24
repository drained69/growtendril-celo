import { createPublicClient, createWalletClient, http } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { toDataSuffix } from "@celo/attribution-tags";
import { CELO, custodyProblem, platformCustody } from "./config";

export const publicClient = () => createPublicClient({chain: celo, transport: http(CELO.rpcUrl, {timeout: 15_000, retryCount: 1})});
export function attributionSuffix() {
  const code = process.env.CELO_ATTRIBUTION_CODE;
  if (!code || !/^[a-z0-9_]{1,32}$/.test(code)) throw new Error("Configure the attribution tag issued by Loops before sending transactions.");
  return toDataSuffix(code);
}
export function agentAccount() {
  if (!platformCustody()) throw new Error(custodyProblem() ?? "Celo signing is not configured");
  return privateKeyToAccount(process.env.CELO_AGENT_PRIVATE_KEY as `0x${string}`, { nonceManager });
}
export function agentWalletClient() {
  return createWalletClient({account: agentAccount(), chain: celo, transport: http(CELO.rpcUrl, {retryCount: 0}), dataSuffix: attributionSuffix()});
}
/** Why the shared protocol operator cannot act. It only ever holds the limited role each workspace grants it. */
export function operatorProblem(): string | null {
  const key = process.env.CELO_AGENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return "Configure CELO_AGENT_PRIVATE_KEY for the protocol operator.";
  if (!/^[a-z0-9_]{1,32}$/.test(process.env.CELO_ATTRIBUTION_CODE ?? "")) return "Set CELO_ATTRIBUTION_CODE to the tag issued when you enroll.";
  return null;
}
export function operatorAccount() {
  const problem = operatorProblem();
  if (problem) throw new Error(problem);
  return privateKeyToAccount(process.env.CELO_AGENT_PRIVATE_KEY as `0x${string}`, { nonceManager });
}
export function operatorWalletClient() {
  return createWalletClient({account: operatorAccount(), chain: celo, transport: http(CELO.rpcUrl, {retryCount: 0}), dataSuffix: attributionSuffix()});
}
export async function assertCeloMainnet() {
  if (await publicClient().getChainId() !== CELO.chainId) throw new Error("RPC must be Celo mainnet (42220)");
}
