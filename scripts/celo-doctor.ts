/** Read-only mainnet readiness. Usage: npm run doctor -- --role=web,buyer (or --role=seller). Sends nothing. */
import { erc20Abi, parseAbi } from "viem";
import { CELO, IDENTITY_REGISTRY, custodyProblem, parseAgentId, platformCustody } from "../src/server/integrations/celo/config";
import { publicClient, agentAccount } from "../src/server/integrations/celo/client";
import { selfAgent } from "../src/server/integrations/celo/self";
import { evaluateReadiness, parseRoles, type ChainFacts } from "../src/server/integrations/celo/readiness";

const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function tokenURI(uint256 tokenId) view returns (string)"]);
const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => {try {return await read();} catch {return null;}};

const roles = parseRoles(process.argv.slice(2));
const client = publicClient();
const custody = platformCustody();
const agentAddress = custody ? agentAccount().address : null;
const agentId = parseAgentId(process.env.CELO_AGENT_ID);
const facts: ChainFacts = {
  rpcChainId: await attempt(() => client.getChainId()), custody, agentAddress,
  nativeGasWei: agentAddress ? await attempt(() => client.getBalance({address: agentAddress})) : null,
  usdcMicro: agentAddress ? await attempt(() => client.readContract({address: CELO.usdc, abi: erc20Abi, functionName: "balanceOf", args: [agentAddress]})) : null,
  identityOwner: agentId !== null ? await attempt(() => client.readContract({address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(agentId)]})) : null,
  identityUri: agentId !== null ? await attempt(() => client.readContract({address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [BigInt(agentId)]})) : null,
  selfVerified: custody && process.env.SELF_AGENT_ENABLED === "1" ? await attempt(async () => (await selfAgent().getInfo()).isVerified) : null,
};
const checks = evaluateReadiness(process.env, facts, roles);
const ready = checks.every((check) => check.ok);
console.log(JSON.stringify({ready, roles, network: CELO.caip2, agentAddress, custodyProblem: custodyProblem(), failing: checks.filter((check) => !check.ok).map((check) => `${check.role}:${check.id}`), checks}, null, 2));
if (!ready) process.exitCode = 1;
