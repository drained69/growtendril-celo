/**
 * Runs the real application code against the real contracts on a private local fork of Celo mainnet.
 * Sends nothing to the live network, uses throwaway keys, and never reads .env.
 *
 *   npm run celo:e2e
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, keccak256, pad, parseEther, toHex, type Abi, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toDataSuffix } from "@celo/attribution-tags";
import { GROWTH_FACTORY_ABI, GROWTH_LEDGER_ABI, GROWTH_WORKSPACE_ABI } from "../src/lib/celo-protocol-abi";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;
const REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address;
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address;
const USDC_BALANCE_SLOT = 9n;
const TAG = "rehearsal";
const ws = GROWTH_WORKSPACE_ABI as Abi;
const passed: string[] = [];
const check = (name: string, ok: boolean) => { if (!ok) throw new Error(`FAILED: ${name}`); passed.push(name); };
const refuses = async (name: string, task: () => Promise<unknown>, reason: RegExp) => {
  const message = await task().then(() => "").catch((e: Error) => e.message ?? String(e));
  check(name, reason.test(message));
};
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const {port: p} = server.address() as {port: number}; server.close(() => resolve(p)); });
});
const rpc = `http://127.0.0.1:${port}`;
if (spawnSync("forge", ["build", "--silent"], {cwd: "contracts"}).status !== 0) throw new Error("forge build failed");
const anvil = spawn("anvil", ["--fork-url", "https://forno.celo.org", "--port", String(port), "--chain-id", "42220"], {stdio: "ignore"});
const quietLog = console.log;

try {
  let ready = false;
  for (let i = 0; i < 180 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ready = await fetch(rpc, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_chainId", params: []})}).then((r) => r.ok).catch(() => false);
  }
  if (!ready) throw new Error("The local Celo fork did not start");
  const client = createPublicClient({chain: celo, transport: http(rpc, {timeout: 60_000})});
  const test = createTestClient({mode: "anvil", chain: celo, transport: http(rpc)});
  const dataSuffix = toDataSuffix(TAG);
  const actor = async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({address: account.address, value: parseEther("50")});
    return {account, wallet: createWalletClient({account, chain: celo, transport: http(rpc), dataSuffix})};
  };
  const deployer = await actor(), owner = await actor();
  const creator = privateKeyToAccount(generatePrivateKey()).address;
  const operatorKey = generatePrivateKey();
  await test.setBalance({address: privateKeyToAccount(operatorKey).address, value: parseEther("50")});
  const deploy = async (file: string, abi: Abi, args: unknown[]) => {
    const artifact = JSON.parse(readFileSync(`contracts/out/${file}`, "utf8")) as {bytecode: {object: Hex}};
    const hash = await deployer.wallet.deployContract({abi, bytecode: artifact.bytecode.object, args: args as never});
    const receipt = await client.waitForTransactionReceipt({hash});
    if (!receipt.contractAddress) throw new Error(`${file} did not deploy`);
    return receipt.contractAddress;
  };
  const factory = await deploy("GrowthFactory.sol/GrowthFactory.json", GROWTH_FACTORY_ABI as Abi, [USDC, USDT, REACTOR, [CNGN]]);
  const ledger = await deploy("GrowthLedger.sol/GrowthLedger.json", GROWTH_LEDGER_ABI as Abi, [factory]);

  for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "TEXTILE_API_KEY", "DATABASE_URL", "CELO_AGENT_PROJECT_ID"]) delete process.env[key];
  Object.assign(process.env, {PGLITE_DIR: "memory://", GROWTHOS_WORKER: "off", CELO_MAINNET_RPC: rpc, CELO_AGENT_PRIVATE_KEY: operatorKey, CELO_ATTRIBUTION_CODE: TAG, CELO_GROWTH_FACTORY: factory, CELO_GROWTH_LEDGER: ledger});
  console.log = () => {};

  const {getDb, schema: s} = await import("../src/server/db/client");
  const {DEFAULT_POLICY} = await import("../src/server/domain/agent/policy");
  const {loadPolicy} = await import("../src/server/domain/agent/ledger");
  const {proposeFinancialAction, refreshSettlements, resolveApproval} = await import("../src/server/domain/agent/execute");
  const protocol = await import("../src/server/integrations/celo/protocol");
  const {merkleProof} = await import("../src/lib/merkle");
  const {eq} = await import("drizzle-orm");
  const db = await getDb();
  const now = Date.now();
  await db.insert(s.users).values({id: "user", email: "owner@example.test", name: "Owner", passwordHash: "x", emailVerifiedAt: new Date()});
  await db.insert(s.projects).values({id: "project", ownerId: "user", name: "Rehearsal", webhookSecret: "x"});
  await db.insert(s.policies).values({id: "policy", projectId: "project", ...DEFAULT_POLICY});
  await db.insert(s.missions).values({id: "mission", projectId: "project", template: "first_customers", name: "First customers", goalDescription: "Find customers", goalEvent: "purchase", goalTarget: 10, budgetMicro: 30_000_000, startsAt: new Date(now - 86_400_000), endsAt: new Date(now + 20 * 86_400_000), status: "active", dataMode: "LIVE"});
  await db.insert(s.missionBudgets).values({id: "budget", missionId: "mission", category: "kol", allocatedMicro: 30_000_000} as never);
  await db.insert(s.experiments).values({id: "experiment", projectId: "project", missionId: "mission", number: 1, title: "Creator test", hypothesis: "Creators convert", channel: "kol", budgetCategory: "kol", target: "creators", action: "post", budgetMicro: 20_000_000, successEvent: "purchase", successTarget: 2, stopMaxCpaMicro: 10_000_000, stopAfterSpendMicro: 20_000_000, timeframeDays: 14, status: "running", recipientAddress: creator, dataMode: "LIVE"} as never);

  const send = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const {request} = await client.simulateContract({account: owner.account, address, abi, functionName, args});
    const receipt = await client.waitForTransactionReceipt({hash: await owner.wallet.writeContract(request as never)});
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  };
  const policy = await loadPolicy(db, "project");
  await send(factory, GROWTH_FACTORY_ABI as Abi, "createWorkspace", [protocol.workspaceRef("project"), privateKeyToAccount(operatorKey).address, protocol.onchainPolicy(policy)]);
  const workspace = await client.readContract({address: factory, abi: GROWTH_FACTORY_ABI, functionName: "addressOf", args: [owner.account.address, protocol.workspaceRef("project")]});
  await protocol.linkWorkspace(db, {projectId: "project", userId: "user", address: workspace});
  const [linked] = await db.select().from(s.wallets).where(eq(s.wallets.projectId, "project"));
  check("App links only the workspace created for this project", linked.provider === "growth_vault" && linked.address?.toLowerCase() === workspace.toLowerCase());
  await refuses("App refuses a contract from another project", () => protocol.verifyWorkspace("another-project", workspace), /different workspace/);
  await test.setStorageAt({address: USDC, index: keccak256(`0x${pad(workspace).slice(2)}${toHex(USDC_BALANCE_SLOT, {size: 32}).slice(2)}`), value: toHex(25_000_000n, {size: 32})});

  const payment = (installment: number) => ({action: "send_payment", purpose: "kol_payment", recipient: creator, amount: "5", chain: "Celo", experimentId: "experiment", installment, reasonCode: "PAY_CREATOR", currency: "USDC", missionId: "mission", confidence: 0.8, expectedValue: "medium"});
  const propose = (installment: number) => proposeFinancialAction(db, {projectId: "project", input: payment(installment), rationale: "Pay for the accepted post", reasons: ["accepted"], title: "Pay creator"});
  const txFor = async (decisionId: string) => (await db.select().from(s.transactions).where(eq(s.transactions.decisionId, decisionId)))[0];
  const first = await propose(1);
  check("A creator payment waits for human approval", first.verdict === "APPROVAL_REQUIRED" && !!first.approvalId);
  const tx = await txFor(first.decisionId);
  await refuses("Payment is refused until the mission is published", () => protocol.ensureVaultIntent(db, tx, tx.amountMicro), /Publish this mission/);
  const [missionRow] = await db.select().from(s.missions).where(eq(s.missions.id, "mission"));
  const view = await protocol.loadProtocolView(db, {id: "project"}, linked, policy, missionRow);
  check("Wallet view reads spending rules from the contract", !!view?.policyInSync && view.owner?.toLowerCase() === owner.account.address.toLowerCase());
  await send(workspace, ws, "openMission", [view!.mission!.id, BigInt(view!.mission!.budget), BigInt(view!.mission!.endsAt), view!.mission!.goalHash, view!.mission!.categories, view!.mission!.budgets.map(BigInt)]);
  const intent = await protocol.ensureVaultIntent(db, tx, tx.amountMicro);
  check("Payment is published onchain as pending", intent.state === protocol.INTENT_STATE.Pending);
  await refuses("App cannot approve without the owner's onchain signature", () => protocol.assertVaultApproved(db, tx, tx.amountMicro), /Approve this payment in your wallet/);
  await refuses("Server operator cannot execute an unapproved payment", () => protocol.executeVaultPayment(db, tx), /still needs approval/);
  await send(workspace, ws, "approve", [intent.intentId]);
  await protocol.assertVaultApproved(db, tx, tx.amountMicro);
  const resolved = await resolveApproval(db, {approvalId: first.approvalId!, userId: "user", resolution: "approve"});
  check("Approved payment is submitted", resolved.status === "approved" && !!resolved.txHash);
  await refreshSettlements(db, "project");
  const settled = await txFor(first.decisionId);
  const paid = await client.readContract({address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [creator]});
  check("Ledger settles only after Celo shows the exact payment", settled.state === "SETTLED" && settled.chainCheck === "verified" && paid === 5_000_000n);
  const sent = await client.getTransaction({hash: settled.txHash as Hex});
  check("Operator payout carries the attribution tag", sent.input.toLowerCase().endsWith(dataSuffix.slice(2).toLowerCase()));

  const second = await propose(2);
  const secondTx = await txFor(second.decisionId);
  const secondIntent = await protocol.ensureVaultIntent(db, secondTx, secondTx.amountMicro);
  check("Open payment reserves funds", await client.readContract({address: workspace, abi: ws, functionName: "reserved", args: [USDC]}) === 5_000_000n);
  const open = await protocol.openVaultIntents(db, secondTx, [secondTx.amountMicro]);
  await send(workspace, ws, "rejectMany", [open.intentIds]);
  await resolveApproval(db, {approvalId: second.approvalId!, userId: "user", resolution: "reject"});
  check("Rejection closes the payment onchain and frees funds", await client.readContract({address: workspace, abi: ws, functionName: "reserved", args: [USDC]}) === 0n && (await txFor(second.decisionId)).state === "REJECTED" && secondIntent.intentId === open.intentIds[0]);

  await send(workspace, ws, "setFrozen", [true]);
  const third = await propose(3);
  const thirdTx = await txFor(third.decisionId);
  await refuses("Kill switch stops new onchain payments", () => protocol.ensureVaultIntent(db, thirdTx, thirdTx.amountMicro), /frozen/);
  await protocol.syncWorkspaceToChain(db, "project");
  check("App mirrors the onchain kill switch", (await db.select().from(s.wallets).where(eq(s.wallets.projectId, "project")))[0].frozen === true);
  await send(workspace, ws, "setFrozen", [false]);

  await db.insert(s.campaigns).values({id: "campaign", projectId: "project", experimentId: "experiment", name: "Creator link", channel: "kol", utmSource: "creator", utmMedium: "post", utmCampaign: "test", referralCode: "rehearse1", destinationUrl: "https://example.test", dataMode: "LIVE"} as never);
  for (const [id, eventType, visitorId, valueMicro] of [["event-1", "signup", "visitor-a", 0], ["event-2", "purchase", "visitor-a", 40_000_000], ["event-3", "refund", "visitor-a", 5_000_000]] as const) {
    await db.insert(s.conversionEvents).values({id, projectId: "project", campaignId: "campaign", eventType, visitorId, valueMicro, source: "webhook", idempotencyKey: `rehearsal-${id}`, occurredAt: new Date(), dataMode: "LIVE"});
    await db.insert(s.attribution).values({id: `attribution-${id}`, conversionEventId: id, campaignId: "campaign", experimentId: "experiment", model: "referral_code", weight: 1} as never);
  }
  await protocol.syncWorkspaceToChain(db, "project");
  const totals = await client.readContract({address: ledger, abi: GROWTH_LEDGER_ABI as Abi, functionName: "outcomes", args: [workspace, protocol.protocolId("experiment", "experiment")]}) as readonly bigint[];
  check("Measured outcomes are recorded onchain", totals[0] === 1n && totals[2] === 1n && totals[3] === 40_000_000n && totals[4] === 5_000_000n);
  const [checkpoint] = await db.select().from(s.protocolCheckpoints).where(eq(s.protocolCheckpoints.projectId, "project"));
  check("Decision receipts are committed to the ledger", !!checkpoint && checkpoint.records > 0);
  const leaf = checkpoint.leaves[0] as Hex;
  const proven = await client.readContract({address: ledger, abi: GROWTH_LEDGER_ABI as Abi, functionName: "verifyRecord", args: [workspace, BigInt(checkpoint.number), leaf, merkleProof(checkpoint.leaves as Hex[], leaf)]});
  const forged = await client.readContract({address: ledger, abi: GROWTH_LEDGER_ABI as Abi, functionName: "verifyRecord", args: [workspace, BigInt(checkpoint.number), keccak256(toHex("forged")), merkleProof(checkpoint.leaves as Hex[], leaf)]});
  check("Anyone can prove a committed record, and a forged one fails", proven === true && forged === false);
  const agent = privateKeyToAccount(operatorKey).address;
  await send(workspace, ws, "setRole", [agent, 0]);
  await protocol.syncWorkspaceToChain(db, "project");
  const removed = await protocol.loadProtocolView(db, {id: "project"}, linked, policy, missionRow);
  check("Owner removes the agent and the app keeps working", removed?.operatorActive === false);
  const fourth = await propose(4);
  const fourthTx = await txFor(fourth.decisionId);
  await refuses("A removed agent cannot publish a payment", () => protocol.ensureVaultIntent(db, fourthTx, fourthTx.amountMicro), /not allowed to act on your workspace contract/);
  await send(workspace, ws, "setRole", [agent, 4]);
  const restored = await protocol.loadProtocolView(db, {id: "project"}, linked, policy, missionRow);
  check("Owner can restore the agent", restored?.operatorActive === true);
  await send(workspace, ws, "withdraw", [USDC, owner.account.address, 20_000_000n]);
  check("Owner withdraws all unreserved USDC", await client.readContract({address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [workspace]}) === 0n);
  console.log = quietLog;
  console.log(JSON.stringify({result: "PASSED", realTransactionSent: false, checks: passed.length, passed}, null, 2));
} catch (error) {
  console.log = quietLog;
  console.error(JSON.stringify({result: "FAILED", passedBeforeFailure: passed.length, error: (error as Error).message?.slice(0, 900)}, null, 2));
  process.exitCode = 1;
} finally {
  anvil.kill();
}
process.exit(process.exitCode ?? 0);
