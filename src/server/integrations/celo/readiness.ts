import { isAddress } from "viem";
import { CELO, parseAgentId } from "./config";

export const READINESS_ROLES = ["web", "buyer", "seller"] as const;
export type ReadinessRole = (typeof READINESS_ROLES)[number];
export interface ReadinessCheck {id: string; role: ReadinessRole; ok: boolean; detail: string}

/** Facts read from Celo by the doctor. `null` means the read failed or was not possible. */
export interface ChainFacts {
  rpcChainId: number | null;
  custody: "celo" | null;
  agentAddress: string | null;
  nativeGasWei: bigint | null;
  usdcMicro: bigint | null;
  identityOwner: string | null;
  identityUri: string | null;
  selfVerified: boolean | null;
}

type Env = Record<string, string | undefined>;

function httpsOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}
function encryptionKeyValid(value: string | undefined): boolean {
  const key = value?.trim() ?? "";
  if (/^[0-9a-f]{64}$/i.test(key)) return true;
  return /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;
}
const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Mainnet readiness by service role. Configuration presence alone never passes an onchain requirement. */
export function evaluateReadiness(env: Env, chain: ChainFacts, roles: readonly ReadinessRole[]): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const add = (role: ReadinessRole, id: string, ok: boolean, detail: string) => {if (roles.includes(role)) checks.push({id, role, ok, detail});};
  const rpcOk = chain.rpcChainId === CELO.chainId;
  const rpcDetail = rpcOk ? `Celo mainnet (${CELO.chainId})` : "RPC unavailable or not Celo mainnet";
  const origin = httpsOrigin(env.APP_URL);
  const agentId = parseAgentId(env.CELO_AGENT_ID);
  const expectedUri = origin ? `${origin}/.well-known/agent-registration.json` : null;
  const researchUrls = (env.CELO_RESEARCH_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean);

  add("web", "rpc", rpcOk, rpcDetail);
  add("web", "database", /^postgres(?:ql)?:\/\//.test(env.DATABASE_URL?.trim() ?? ""), "External PostgreSQL DATABASE_URL");
  add("web", "session_secret", (env.SESSION_SECRET?.length ?? 0) >= 32, "SESSION_SECRET has at least 32 characters");
  add("web", "encryption_key", encryptionKeyValid(env.ENCRYPTION_KEY), "ENCRYPTION_KEY is 32 bytes (hex or base64)");
  add("web", "app_url", !!origin, "APP_URL is an HTTPS origin");

  add("buyer", "rpc", rpcOk, rpcDetail);
  add("buyer", "custody", chain.custody === "celo" && !!chain.agentAddress, "Agent key, workspace binding and attribution tag are valid");
  add("buyer", "gas", (chain.nativeGasWei ?? 0n) > 0n, "Agent wallet holds CELO for gas");
  add("buyer", "usdc", (chain.usdcMicro ?? 0n) > 0n, "Agent wallet holds Celo USDC");
  add("buyer", "erc8004_id", agentId !== null, "CELO_AGENT_ID is a canonical token ID");
  add("buyer", "erc8004_owner", same(chain.identityOwner, chain.agentAddress), "Identity is owned by the agent wallet onchain");
  add("buyer", "erc8004_uri", !!expectedUri && chain.identityUri === expectedUri, "Onchain agent URI matches this deployment");
  add("buyer", "self_enabled", env.SELF_AGENT_ENABLED === "1", "SELF_AGENT_ENABLED=1");
  add("buyer", "self_verified", chain.selfVerified === true, "Agent wallet has a current Self human proof");
  add("buyer", "research_urls", researchUrls.length > 0 && researchUrls.every((url) => !!httpsOrigin(url)), "CELO_RESEARCH_URLS lists HTTPS sellers");

  add("seller", "rpc", rpcOk, rpcDetail);
  add("seller", "seller_address", isAddress(env.SIGNALS_SELLER_ADDRESS ?? ""), "SIGNALS_SELLER_ADDRESS is a valid PayTo address");
  add("seller", "x402_api_key", !!env.X402_API_KEY?.trim(), "X402_API_KEY is configured");
  return checks;
}

export function parseRoles(argv: readonly string[]): ReadinessRole[] {
  const arg = argv.find((value) => value.startsWith("--role="));
  if (!arg) return [...READINESS_ROLES];
  const roles = arg.slice("--role=".length).split(",").map((role) => role.trim());
  const invalid = roles.filter((role) => !READINESS_ROLES.includes(role as ReadinessRole));
  if (!roles.length || invalid.length) throw new Error(`Unknown role. Use --role=${READINESS_ROLES.join(",")}`);
  return [...new Set(roles)] as ReadinessRole[];
}
