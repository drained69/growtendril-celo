import { SelfAgent, SelfAgentVerifier } from "@selfxyz/agent-sdk";
import { CELO } from "./config";
import { agentAccount } from "./client";

export function selfAgent() {
  agentAccount(); // Validate configuration without exposing key material.
  return new SelfAgent({privateKey: process.env.CELO_AGENT_PRIVATE_KEY!, network: "mainnet", rpcUrl: CELO.rpcUrl});
}
export async function selfHeaders(method: string, url: string, body?: string): Promise<Record<string, string>> {
  if (process.env.SELF_AGENT_ENABLED !== "1") return {};
  return selfAgent().signRequest(method, url, body);
}
export const createSelfVerifier = () => SelfAgentVerifier.create().network("mainnet").rpc(CELO.rpcUrl).cacheTtl(0).rateLimit({perMinute: 10}).build();
