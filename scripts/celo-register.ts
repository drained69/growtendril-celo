import { encodeFunctionData, parseAbi, parseEventLogs } from "viem";
import { CELO, IDENTITY_REGISTRY } from "../src/server/integrations/celo/config";
import { agentWalletClient, assertCeloMainnet, attributionSuffix, publicClient } from "../src/server/integrations/celo/client";

const origin = new URL(process.env.APP_URL || "https://celo.growtendril.xyz");
if (origin.protocol !== "https:") throw new Error("Publish the agent metadata on HTTPS before registering");
const agentURI = `${origin.origin}/.well-known/agent-registration.json`;
const abi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
const data = encodeFunctionData({abi, functionName: "register", args: [agentURI]});
if (!process.argv.includes("--submit")) {
  console.log(JSON.stringify({mode: "preview", network: CELO.caip2, to: IDENTITY_REGISTRY, agentURI, data,
    next: "Set the event-issued CELO_ATTRIBUTION_CODE and dedicated wallet configuration, publish the metadata, then run npm run celo:register -- --submit. This spends CELO gas."}, null, 2));
} else {
  const wallet = agentWalletClient();
  await assertCeloMainnet();
  const metadata = await fetch(agentURI, {signal: AbortSignal.timeout(15000)});
  if (!metadata.ok || (await metadata.json()).type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") throw new Error("Publish valid ERC-8004 metadata first");
  const count = await publicClient().readContract({address: IDENTITY_REGISTRY, abi, functionName: "balanceOf", args: [wallet.account.address]});
  if (count > 0n) throw new Error("This wallet already owns an identity. Inspect it and set CELO_AGENT_ID instead of registering a duplicate.");
  const request = await publicClient().simulateContract({account: wallet.account, address: IDENTITY_REGISTRY, abi, functionName: "register", args: [agentURI], dataSuffix: attributionSuffix()});
  const hash = await wallet.writeContract(request.request);
  console.log(`Submitted: ${CELO.explorer}/tx/${hash}`);
  const receipt = await publicClient().waitForTransactionReceipt({hash});
  if (receipt.status !== "success") throw new Error("Registration reverted");
  const [event] = parseEventLogs({abi, eventName: "Registered", logs: receipt.logs.filter(l => l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase())});
  if (!event) throw new Error("Registration event missing; inspect the transaction before retrying");
  console.log(`Set CELO_AGENT_ID=${event.args.agentId} and add the wallet and identity to your Loops entry.`);
}
