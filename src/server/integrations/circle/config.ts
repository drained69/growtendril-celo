/** Arc network constants, pinned so the running Celo app does not load the retired Circle SDK. */
const ARC_CHAIN_ID = 5042;
const ARC_PUBLIC_RPC = "https://rpc.mainnet.arc.io";

export const ARC = {
  name: "Arc Mainnet",
  chainId: ARC_CHAIN_ID,
  caip2: `eip155:${ARC_CHAIN_ID}`,
  gatewayDomain: 26,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" as `0x${string}`,
  gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205" as `0x${string}`,
  /** Server-side RPC. ARC_MAINNET_RPC may carry a private API key, so it never goes to a browser. */
  rpcUrl: process.env.ARC_MAINNET_RPC || ARC_PUBLIC_RPC,
  /** Public RPC for anything a browser or a payer's wallet sees. */
  publicRpcUrl: ARC_PUBLIC_RPC,
  explorer: "https://explorer.arc.io",
  appKitChain: "Arc" as const,
  circleBlockchain: "ARC" as const,
};

export const GATEWAY_API = process.env.GATEWAY_API_URL || "https://gateway-api.circle.com";
export const DISCOVERY_API = process.env.CIRCLE_DISCOVERY_URL || "https://api.circle.com/v2/x402/discovery/resources";

/** App Kit chain id → Circle Wallets blockchain id → explorer, for chains GrowTendril may use. */
export const CHAINS: Record<string, { label: string; circle: string; explorer: string; caip2: string; rpc: string }> = {
  Arc: { label: "Arc Mainnet", circle: "ARC", explorer: ARC.explorer, caip2: ARC.caip2, rpc: ARC.rpcUrl },
  // Historical testnet records still need the correct explorer links.
  Arc_Testnet: { label: "Arc Testnet", circle: "ARC-TESTNET", explorer: "https://explorer.testnet.arc.io", caip2: "eip155:5042002", rpc: process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.io" },
  Base_Sepolia: { label: "Base Sepolia", circle: "BASE-SEPOLIA", explorer: "https://sepolia.basescan.org", caip2: "eip155:84532", rpc: "https://sepolia.base.org" },
  Arbitrum_Sepolia: { label: "Arbitrum Sepolia", circle: "ARB-SEPOLIA", explorer: "https://sepolia.arbiscan.io", caip2: "eip155:421614", rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  Ethereum_Sepolia: { label: "Ethereum Sepolia", circle: "ETH-SEPOLIA", explorer: "https://sepolia.etherscan.io", caip2: "eip155:11155111", rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
};

export const txExplorerUrl = (chain: string, hash: string) => `${CHAINS[chain]?.explorer ?? ARC.explorer}/tx/${hash}`;
export const addressExplorerUrl = (chain: string, addr: string) => `${CHAINS[chain]?.explorer ?? ARC.explorer}/address/${addr}`;

export type WalletProvider = "circle_dcw" | "local_testnet" | "unconfigured";

/** Mainnet wallets require Circle custody; a local testnet key is never used here. */
export function platformCustody(): "circle" | null {
  if (process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET && !custodyProblem()) return "circle";
  return null;
}

/** Circle labels credentials by environment. Reject unknown prefixes too. */
export function circleKeyEnvironment(key = process.env.CIRCLE_API_KEY): "live" | "test" | "unknown" | null {
  if (!key) return null;
  if (/^LIVE_API_KEY:[^:]+:[^:]+$/.test(key)) return "live";
  if (/^TEST_API_KEY:[^:]+:[^:]+$/.test(key)) return "test";
  return "unknown";
}

/** A public explanation; never includes any part of the credential. */
export function custodyProblem(): string | null {
  const environment = circleKeyEnvironment();
  if (!environment) return null;
  if (environment === "test") return "CIRCLE_API_KEY is a TEST key. Arc mainnet requires a LIVE_API_KEY from Circle.";
  if (environment === "unknown") return "CIRCLE_API_KEY does not have a complete LIVE_API_KEY format for Arc mainnet.";
  return null;
}
