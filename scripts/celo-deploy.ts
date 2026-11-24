/**
 * Deploy the GrowTendril protocol to Celo mainnet: rewards escrow, workspace factory and public ledger.
 *
 *   npm run celo:deploy                                  read-only preflight; sends nothing
 *   npm run celo:deploy -- --rehearse                    full deployment and a real-USDC payment on a private local fork
 *   npm run celo:deploy -- --broadcast --confirm-mainnet real, tagged mainnet transactions that spend CELO gas
 *   npm run celo:deploy -- --verify                      retry source verification of a finished deployment
 *
 * The key is read from CELO_DEPLOYER_PRIVATE_KEY or CELO_AGENT_PRIVATE_KEY and is never printed.
 * Progress is saved after every transaction, so an interrupted deployment resumes without duplicates.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeDeployData, erc20Abi, formatEther, http, keccak256, pad, parseEther, toHex, type Abi, type Address, type Hash, type Hex } from "viem";
import { celo } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toDataSuffix } from "@celo/attribution-tags";
import { isOutcomeEscrowCode, OUTCOME_ESCROW_ABI } from "../packages/arc-growth-tools/dist/escrow.js";
import { GROWTH_FACTORY_ABI, GROWTH_LEDGER_ABI, GROWTH_WORKSPACE_ABI } from "../src/lib/celo-protocol-abi";
import { CELO } from "../src/server/integrations/celo/config";
import { PAYOUT_TOKENS, TEXTILE_REACTOR, USDT } from "../src/server/integrations/celo/corridors";

const HOLD = 72n * 60n * 60n;
const RECORD = "contracts/deployments/celo-mainnet.json";
const USDC_BALANCE_SLOT = 9n;
const PAYOUT_ADDRESSES = Object.values(PAYOUT_TOKENS).map((token) => token.address);
const args = process.argv.slice(2);
const known = new Set(["--rehearse", "--broadcast", "--confirm-mainnet", "--verify"]);
if (args.some((arg) => !known.has(arg))) throw new Error("Usage: npm run celo:deploy -- [--rehearse | --broadcast --confirm-mainnet | --verify]");
const rehearse = args.includes("--rehearse");
const broadcast = args.includes("--broadcast");
const verifyOnly = args.includes("--verify");
if ([rehearse, broadcast, verifyOnly].filter(Boolean).length > 1) throw new Error("Choose one of --rehearse, --broadcast or --verify");
if (broadcast && !args.includes("--confirm-mainnet")) throw new Error("A real deployment also needs --confirm-mainnet");

type Name = "OutcomeRewardsEscrow" | "GrowthFactory" | "GrowthLedger";
type Entry = {address?: Address; transactionHash?: Hash; block?: number};
type Saved = Partial<Record<Name, Entry>>;
const say = (value: Record<string, unknown>) => console.log(JSON.stringify(value, null, 2));
const clientFor = (rpc: string) => createPublicClient({chain: celo, transport: http(rpc, {timeout: 60_000, retryCount: 1})});
const artifactFile: Record<Name, string> = {OutcomeRewardsEscrow: "OutcomeRewardsEscrow.sol/OutcomeRewardsEscrow.json", GrowthFactory: "GrowthFactory.sol/GrowthFactory.json", GrowthLedger: "GrowthLedger.sol/GrowthLedger.json"};
const abiOf: Record<Name, Abi> = {OutcomeRewardsEscrow: OUTCOME_ESCROW_ABI as Abi, GrowthFactory: GROWTH_FACTORY_ABI as Abi, GrowthLedger: GROWTH_LEDGER_ABI as Abi};

function compiled() {
  if (spawnSync("forge", ["build", "--silent"], {cwd: "contracts", encoding: "utf8"}).status !== 0) throw new Error("forge build failed. Install Foundry and check the contracts.");
  const load = (name: Name) => JSON.parse(readFileSync(`contracts/out/${artifactFile[name]}`, "utf8")) as {bytecode: {object: Hex}; deployedBytecode: {object: Hex}};
  const out = {OutcomeRewardsEscrow: load("OutcomeRewardsEscrow"), GrowthFactory: load("GrowthFactory"), GrowthLedger: load("GrowthLedger")};
  if (!isOutcomeEscrowCode(out.OutcomeRewardsEscrow.deployedBytecode.object)) throw new Error("The compiled escrow differs from the app's artifact. Run npm run arc:contracts:generate.");
  return out;
}
const artifacts = compiled();
const argsFor = (name: Name, factory?: Address): readonly unknown[] => name === "OutcomeRewardsEscrow" ? [CELO.usdc, HOLD] : name === "GrowthFactory" ? [CELO.usdc, USDT.address, TEXTILE_REACTOR, PAYOUT_ADDRESSES] : [factory];

function deployerKey(): Hex | null {
  const key = process.env.CELO_DEPLOYER_PRIVATE_KEY?.trim() || process.env.CELO_AGENT_PRIVATE_KEY?.trim();
  if (!key) return null;
  if (!/^0x[\da-f]{64}$/i.test(key)) throw new Error("The deployer key must be a 0x-prefixed 32-byte private key");
  return key as Hex;
}

async function assertSuite(client: ReturnType<typeof clientFor>, escrow: Address, factory: Address, ledger: Address) {
  const code = await client.getCode({address: escrow});
  if (!code || !isOutcomeEscrowCode(code)) throw new Error("Escrow runtime does not match the reviewed build");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const read = <T>(address: Address, abi: Abi, functionName: string, fnArgs: unknown[] = []) => client.readContract({address, abi, functionName, args: fnArgs}) as Promise<T>;
  const [escrowToken, hold, usdc, usdt, reactor, implementation, linked, payouts] = await Promise.all([
    read<Address>(escrow, OUTCOME_ESCROW_ABI as Abi, "token"), read<bigint>(escrow, OUTCOME_ESCROW_ABI as Abi, "refundHold"),
    read<Address>(factory, GROWTH_FACTORY_ABI as Abi, "usdc"), read<Address>(factory, GROWTH_FACTORY_ABI as Abi, "usdt"), read<Address>(factory, GROWTH_FACTORY_ABI as Abi, "reactor"),
    read<Address>(factory, GROWTH_FACTORY_ABI as Abi, "implementation"), read<Address>(ledger, GROWTH_LEDGER_ABI as Abi, "factory"),
    Promise.all(PAYOUT_ADDRESSES.map((token) => read<boolean>(factory, GROWTH_FACTORY_ABI as Abi, "isPayoutToken", [token]))),
  ]);
  if (!same(escrowToken, CELO.usdc) || hold !== HOLD || !same(usdc, CELO.usdc) || !same(usdt, USDT.address) || !same(reactor, TEXTILE_REACTOR) || !same(linked, factory) || !payouts.every(Boolean)) throw new Error("A deployed contract has the wrong configuration");
  if (!await client.getCode({address: implementation})) throw new Error("Workspace implementation is missing");
}

async function deploySuite(rpc: string, key: Hex, code: string, saved: Saved, save: (next: Saved) => void) {
  const dataSuffix = toDataSuffix(code);
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({account, chain: celo, transport: http(rpc, {timeout: 60_000, retryCount: 0}), dataSuffix});
  const client = clientFor(rpc);
  for (const name of ["OutcomeRewardsEscrow", "GrowthFactory", "GrowthLedger"] as Name[]) {
    if (saved[name]?.address) continue;
    let hash = saved[name]?.transactionHash;
    if (!hash) {
      hash = await wallet.deployContract({abi: abiOf[name], bytecode: artifacts[name].bytecode.object, args: argsFor(name, saved.GrowthFactory?.address) as never});
      saved[name] = {transactionHash: hash};
      save(saved);
      if (!rehearse) console.log(`${name} submitted: ${CELO.explorer}/tx/${hash}`);
    }
    const receipt = await client.waitForTransactionReceipt({hash, timeout: 180_000});
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment reverted: ${CELO.explorer}/tx/${hash}`);
    const sent = await client.getTransaction({hash});
    if (!sent.input.toLowerCase().endsWith(dataSuffix.slice(2).toLowerCase())) throw new Error(`${name} is missing its attribution tag`);
    saved[name] = {address: receipt.contractAddress, transactionHash: hash, block: Number(receipt.blockNumber)};
    save(saved);
  }
  await assertSuite(client, saved.OutcomeRewardsEscrow!.address!, saved.GrowthFactory!.address!, saved.GrowthLedger!.address!);
  return {escrow: saved.OutcomeRewardsEscrow!.address!, factory: saved.GrowthFactory!.address!, ledger: saved.GrowthLedger!.address!};
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const {port} = server.address() as {port: number};
    server.close(() => resolve(port));
  });
});

/** The real product path on a private copy of mainnet: workspace, policy, mission, approval, USDC payout, ledger. */
async function scenario(rpc: string, code: string, suite: {factory: Address; ledger: Address}) {
  const client = clientFor(rpc);
  const test = createTestClient({mode: "anvil", chain: celo, transport: http(rpc)});
  const dataSuffix = toDataSuffix(code);
  const actor = async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({address: account.address, value: parseEther("10")});
    return {account, wallet: createWalletClient({account, chain: celo, transport: http(rpc), dataSuffix})};
  };
  const [owner, agent] = [await actor(), await actor()];
  const creator = privateKeyToAccount(generatePrivateKey()).address;
  const send = async (who: typeof owner, address: Address, abi: Abi, functionName: string, fnArgs: unknown[]) => {
    const {request} = await client.simulateContract({account: who.account, address, abi, functionName, args: fnArgs});
    const hash = await who.wallet.writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  };
  const ref = keccak256(toHex("rehearsal-workspace"));
  const policy = {autonomyEnabled: false, maxTransaction: 0n, dailySpend: 10_000_000n, hardCeiling: 10_000_000n, autonomousCategories: 0, approvalCategories: 127};
  await send(owner, suite.factory, GROWTH_FACTORY_ABI as Abi, "createWorkspace", [ref, agent.account.address, policy]);
  const workspace = await client.readContract({address: suite.factory, abi: GROWTH_FACTORY_ABI, functionName: "addressOf", args: [owner.account.address, ref]});
  await test.setStorageAt({address: CELO.usdc, index: keccak256(`0x${pad(workspace).slice(2)}${toHex(USDC_BALANCE_SLOT, {size: 32}).slice(2)}`), value: toHex(50_000_000n, {size: 32})});
  const block = await client.getBlock();
  const mission = keccak256(toHex("mission")), experiment = keccak256(toHex("experiment")), intent = keccak256(toHex("intent"));
  const ws = GROWTH_WORKSPACE_ABI as Abi;
  await send(owner, workspace, ws, "openMission", [mission, 30_000_000n, block.timestamp + 2_592_000n, keccak256(toHex("goal")), [2], [30_000_000n]]);
  await send(agent, workspace, ws, "openExperiment", [experiment, mission, 20_000_000n, keccak256(toHex("terms"))]);
  await send(agent, workspace, ws, "registerPayee", [creator]);
  await send(agent, workspace, ws, "propose", [{id: intent, missionId: mission, experimentId: experiment, recipient: creator, token: CELO.usdc, payoutToken: "0x0000000000000000000000000000000000000000", amount: 5_000_000n, expiresAt: block.timestamp + 86_400n, category: 2, kind: 0, minPayout: 0n, evidenceHash: keccak256(toHex("evidence"))}]);
  const blocked = await client.simulateContract({account: agent.account, address: workspace, abi: ws, functionName: "execute", args: [intent]}).then(() => false).catch(() => true);
  if (!blocked) throw new Error("The agent paid without approval");
  await send(owner, workspace, ws, "approve", [intent]);
  await send(agent, workspace, ws, "execute", [intent]);
  const paid = await client.readContract({address: CELO.usdc, abi: erc20Abi, functionName: "balanceOf", args: [creator]});
  if (paid !== 5_000_000n) throw new Error("The creator did not receive the approved USDC");
  await send(agent, suite.ledger, GROWTH_LEDGER_ABI as Abi, "commitCheckpoint", [workspace, keccak256(toHex("root")), 3, `0x${"0".repeat(64)}`]);
  return {agentBlockedWithoutApproval: true, creatorPaidUsdc: "5.00", ledgerCheckpoint: 1};
}

async function rehearsal() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--fork-url", CELO.rpcUrl, "--port", String(port), "--chain-id", String(CELO.chainId), "--code-size-limit", "24576"], {stdio: ["ignore", "ignore", "pipe"]});
  let failure = "";
  anvil.stderr.on("data", (chunk) => { failure = String(chunk).slice(0, 300); });
  try {
    let ready = false;
    for (let i = 0; i < 180 && !ready && anvil.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ready = await fetch(rpc, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_chainId", params: []})}).then((r) => r.ok).catch(() => false);
    }
    if (!ready) throw new Error(`The local Celo fork did not start. ${failure}`);
    const key = generatePrivateKey();
    const test = createTestClient({mode: "anvil", chain: celo, transport: http(rpc)});
    await test.setBalance({address: privateKeyToAccount(key).address, value: parseEther("100")});
    const code = process.env.CELO_ATTRIBUTION_CODE || "rehearsal";
    const suite = await deploySuite(rpc, key, code, {}, () => {});
    const result = await scenario(rpc, code, suite);
    say({mode: "rehearsal", network: "private local fork of Celo mainnet", realTransactionSent: false, contracts: suite, configurationVerified: true, attributionTagVerified: true, ...result});
  } finally {
    anvil.kill();
  }
}

/** Publishes source to Sourcify, and to Celoscan when ETHERSCAN_API_KEY is set (forge reads it from the environment). */
async function verifySources(suite: {escrow: Address; factory: Address; ledger: Address}) {
  const implementation = await clientFor(CELO.rpcUrl).readContract({address: suite.factory, abi: GROWTH_FACTORY_ABI as Abi, functionName: "implementation"}) as Address;
  const targets: [string, Address, string, Abi, readonly unknown[]][] = [
    ["OutcomeRewardsEscrow", suite.escrow, "src/OutcomeRewardsEscrow.sol", abiOf.OutcomeRewardsEscrow, argsFor("OutcomeRewardsEscrow")],
    ["GrowthFactory", suite.factory, "src/protocol/GrowthFactory.sol", abiOf.GrowthFactory, argsFor("GrowthFactory")],
    ["GrowthLedger", suite.ledger, "src/protocol/GrowthLedger.sol", abiOf.GrowthLedger, argsFor("GrowthLedger", suite.factory)],
    ["GrowthWorkspace", implementation, "src/protocol/GrowthWorkspace.sol", GROWTH_WORKSPACE_ABI as Abi, [suite.factory, CELO.usdc, USDT.address, TEXTILE_REACTOR]],
  ];
  const verifiers = ["sourcify", ...(process.env.ETHERSCAN_API_KEY?.trim() ? ["etherscan"] : [])];
  const results: Record<string, Record<string, string>> = {};
  for (const [name, address, source, abi, ctorArgs] of targets) {
    const inputs = abi.find((item) => item.type === "constructor")?.inputs ?? [];
    const encoded = encodeAbiParameters(inputs, ctorArgs as unknown[]);
    results[name] = {address};
    for (const verifier of verifiers) {
      const run = spawnSync("forge", ["verify-contract", address, `${source}:${name}`, "--chain", String(CELO.chainId), "--verifier", verifier, "--constructor-args", encoded, "--watch"], {cwd: "contracts", encoding: "utf8", timeout: 180_000});
      const detail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").filter(Boolean).pop() ?? "no output";
      results[name][verifier === "etherscan" ? "celoscan" : verifier] = run.status === 0 ? "verified" : `failed: ${detail.slice(0, 160)}`;
    }
  }
  return results;
}

if (rehearse) {
  await rehearsal();
  process.exit(0);
}

if (verifyOnly) {
  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) as {status?: string; contracts?: Saved} : null;
  const c = record?.contracts;
  if (record?.status !== "deployed" || !c?.OutcomeRewardsEscrow?.address || !c.GrowthFactory?.address || !c.GrowthLedger?.address) throw new Error(`No finished deployment in ${RECORD}`);
  say({verification: await verifySources({escrow: c.OutcomeRewardsEscrow.address, factory: c.GrowthFactory.address, ledger: c.GrowthLedger.address})});
  process.exit(0);
}

const client = clientFor(CELO.rpcUrl);
if (await client.getChainId() !== CELO.chainId) throw new Error("RPC must be Celo mainnet (42220)");
for (const address of [CELO.usdc, USDT.address, TEXTILE_REACTOR, ...PAYOUT_ADDRESSES]) if (!await client.getCode({address})) throw new Error(`Expected contract is missing: ${address}`);
const key = deployerKey();
const deployer = key ? privateKeyToAccount(key).address : null;
const stored = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) as {status?: string; contracts?: Saved} : null;
const saved: Saved = stored?.contracts ?? {};
const from = deployer ?? "0x0000000000000000000000000000000000000001";
const estimate = (name: Name) => saved[name]?.address ? Promise.resolve(0n) : client.estimateGas({account: from, data: encodeDeployData({abi: abiOf[name], bytecode: artifacts[name].bytecode.object, args: argsFor(name, saved.GrowthFactory?.address ?? CELO.usdc) as never})});
const [gasEscrow, gasFactory, gasLedger, gasPrice, balance] = await Promise.all([estimate("OutcomeRewardsEscrow"), estimate("GrowthFactory"), estimate("GrowthLedger"), client.getGasPrice(), deployer ? client.getBalance({address: deployer}) : Promise.resolve(null)]);
const gas = gasEscrow + gasFactory + gasLedger;
const cost = gas * gasPrice;
const needed = cost * 3n / 2n;
const code = process.env.CELO_ATTRIBUTION_CODE ?? "";
const missing = [
  ...(!deployer ? ["CELO_DEPLOYER_PRIVATE_KEY"] : []),
  ...(!/^[a-z0-9_]{1,32}$/.test(code) ? ["CELO_ATTRIBUTION_CODE (issued by Loops)"] : []),
  ...(balance !== null && balance < needed ? [`at least ${formatEther(needed)} CELO in ${deployer}`] : []),
  ...(stored?.status === "deployed" ? [`no existing deployment (${RECORD} is complete)`] : []),
];
say({mode: broadcast ? "broadcast" : "preflight", network: CELO.name, chainId: CELO.chainId, contracts: ["OutcomeRewardsEscrow", "GrowthFactory (with GrowthWorkspace)", "GrowthLedger"], deployer: deployer ?? "not configured", balanceCelo: balance === null ? null : formatEther(balance), estimatedGas: gas.toString(), estimatedCostCelo: formatEther(cost), recommendedBalanceCelo: formatEther(needed), ready: missing.length === 0, missing});
if (!broadcast) process.exit(0);
if (missing.length || !key) throw new Error(`Not deploying. Missing: ${missing.join("; ")}`);

const sourceHash = createHash("sha256");
for (const file of ["contracts/src/OutcomeRewardsEscrow.sol", "contracts/src/protocol/GrowthWorkspace.sol", "contracts/src/protocol/GrowthFactory.sol", "contracts/src/protocol/GrowthLedger.sol"]) sourceHash.update(readFileSync(file));
const base = {network: "Celo mainnet", chainId: CELO.chainId, deployer, compiler: "0.8.30", optimizerRuns: 200, evmVersion: "cancun", sourceSha256: sourceHash.digest("hex"), attributionCode: code};
const write = (status: string, contracts: Saved) => writeFileSync(RECORD, `${JSON.stringify({...base, status, contracts}, null, 2)}\n`);
const suite = await deploySuite(CELO.rpcUrl, key, code, saved, (next) => write("in_progress", next));
write("deployed", saved);
say({status: "deployed", contracts: suite, explorer: `${CELO.explorer}/address/${suite.factory}`, setOnWebService: {CELO_REWARDS_ESCROW: suite.escrow, CELO_GROWTH_FACTORY: suite.factory, CELO_GROWTH_LEDGER: suite.ledger}});
say({verification: await verifySources(suite), retry: "If any verification failed, run npm run celo:deploy -- --verify"});
