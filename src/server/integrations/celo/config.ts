import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const CELO = {
  name: "Celo Mainnet", chainId: celo.id, caip2: "eip155:42220" as const,
  usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const,
  rpcUrl: process.env.CELO_MAINNET_RPC || "https://forno.celo.org",
  publicRpcUrl: "https://forno.celo.org", explorer: "https://celoscan.io",
  appKitChain: "Celo" as const,
  // Kept as a compatibility field for the inherited database and policy interfaces.
  circleBlockchain: "CELO" as const,
};
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const CHAINS: Record<string, {label: string; circle: string; explorer: string; caip2: string; rpc: string}> = {
  Celo: {label: CELO.name, circle: "CELO", explorer: CELO.explorer, caip2: CELO.caip2, rpc: CELO.rpcUrl},
};
export const txExplorerUrl = (chain: string, hash: string) => `${CHAINS[chain]?.explorer ?? CELO.explorer}/tx/${hash}`;
export const addressExplorerUrl = (chain: string, address: string) => `${CHAINS[chain]?.explorer ?? CELO.explorer}/address/${address}`;
/** A canonical ERC-8004 token ID that JSON can carry as a number without losing precision. */
export function parseAgentId(value: string | undefined): number | null {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
export function custodyProblem(): string | null {
  const key = process.env.CELO_AGENT_PRIVATE_KEY;
  if (!key) return null;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error();
    privateKeyToAccount(key as Hex);
  } catch { return "CELO_AGENT_PRIVATE_KEY must be a valid EVM private key."; }
  if (!process.env.CELO_AGENT_PROJECT_ID) return "Bind the agent wallet to a workspace with CELO_AGENT_PROJECT_ID.";
  if (!/^[a-z0-9_]{1,32}$/.test(process.env.CELO_ATTRIBUTION_CODE ?? "")) return "Set CELO_ATTRIBUTION_CODE to the tag issued when you enroll.";
  return null;
}
export function platformCustody(): "celo" | null {
  return process.env.CELO_AGENT_PRIVATE_KEY && !custodyProblem() ? "celo" : null;
}
