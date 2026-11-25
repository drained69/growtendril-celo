import { describe, expect, it } from "vitest";
import { concat, keccak256, toHex, type Hex } from "viem";
import { merkleProof, merkleRoot } from "@/lib/merkle";
import { aggregateOutcomes, intentIdFor, onchainPolicy, protocolId, vaultTermsProblem, workspaceRef } from "@/server/integrations/celo/protocol";
import { PAYOUT_TOKENS } from "@/server/integrations/celo/corridors";

const leaf = (value: string) => keccak256(toHex(value));
/** The same check GrowthLedger.verifyRecord performs. */
const verify = (root: Hex, item: Hex, proof: Hex[]) => proof.reduce((node, sibling) => keccak256(node.toLowerCase() < sibling.toLowerCase() ? concat([node, sibling]) : concat([sibling, node])), keccak256(item)) === root;

describe("ledger Merkle proofs", () => {
  it.each([1, 2, 3, 4, 5, 8, 17, 100])("proves every record in a checkpoint of %i", (size) => {
    const leaves = Array.from({length: size}, (_, i) => leaf(`record-${i}`));
    const root = merkleRoot(leaves);
    for (const item of leaves) expect(verify(root, item, merkleProof(leaves, item))).toBe(true);
  });
  it("does not depend on record order or duplicates", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c")];
    expect(merkleRoot([...leaves].reverse())).toBe(merkleRoot([...leaves, leaves[0]]));
  });
  it("rejects a changed record and refuses an empty checkpoint", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c")];
    expect(verify(merkleRoot(leaves), leaf("forged"), merkleProof(leaves, leaves[0]))).toBe(false);
    expect(() => merkleRoot([])).toThrow();
    expect(() => merkleProof(leaves, leaf("missing"))).toThrow();
  });
});

describe("onchain outcome totals", () => {
  const event = (id: string, eventType: string, visitorId: string | null, valueMicro = 0) => ({id, eventType, visitorId, valueMicro});
  it("counts distinct people and ignores visits", () => {
    expect(aggregateOutcomes([event("1", "visit", "a"), event("2", "signup", "a"), event("3", "signup", "a"), event("4", "purchase", "a", 10), event("5", "purchase", "b", 20), event("6", "refund", "b", 5)])).toEqual({customers: 2n, activated: 1n, paying: 2n, revenue: 30n, refunded: 5n});
  });
  it("never submits totals lower than the chain, which would revert", () => {
    const onchain = {customers: 9n, activated: 4n, paying: 3n, revenue: 90n, refunded: 7n};
    expect(aggregateOutcomes([event("1", "purchase", "a", 10)], onchain)).toEqual(onchain);
  });
  it("keeps refunds within revenue", () => {
    expect(aggregateOutcomes([event("1", "purchase", "a", 10), event("2", "refund", "a", 25)]).refunded).toBe(10n);
  });
});

describe("protocol identifiers and policy", () => {
  it("binds a workspace and intent to exact inputs", () => {
    expect(workspaceRef("p1")).not.toBe(workspaceRef("p2"));
    expect(intentIdFor("tx", 5)).not.toBe(intentIdFor("tx", 6));
    expect(protocolId("mission", "1")).not.toBe(protocolId("experiment", "1"));
  });
  it("maps policy categories to the contract's bitmask", () => {
    expect(onchainPolicy({autonomyEnabled: true, maxTransactionMicro: 1, dailySpendMicro: 2, hardCeilingMicro: 3, autonomousCategories: ["research"], approvalCategories: ["kol", "treasury"]})).toEqual({autonomyEnabled: true, maxTransaction: 1n, dailySpend: 2n, hardCeiling: 3n, autonomousCategories: 1, approvalCategories: 68});
  });
});

describe("terms checked before the owner signs", () => {
  const creator = "0x00000000000000000000000000000000000c4fe5" as const;
  const none = "0x0000000000000000000000000000000000000000" as const;
  const naira = PAYOUT_TOKENS.cNGN.address;
  const usdc = {recipient: creator, amount: 5_000_000n, payoutToken: none, minPayout: 0n};
  const corridor = {recipient: creator, amount: 5_000_000n, payoutToken: naira, minPayout: 7_000_000_000n};
  const fair = 7_200_000_000n;

  it("accepts a USDC payment that matches the approval", () => {
    expect(vaultTermsProblem(usdc, {recipient: creator, amountMicro: 5_000_000, payoutToken: null, fairBuyAmount: null})).toBeNull();
  });
  it("refuses a different recipient, amount or currency", () => {
    expect(vaultTermsProblem({...usdc, recipient: "0x0000000000000000000000000000000000000bad"}, {recipient: creator, amountMicro: 5_000_000, payoutToken: null, fairBuyAmount: null})).toMatch(/does not match/);
    expect(vaultTermsProblem({...usdc, amount: 6_000_000n}, {recipient: creator, amountMicro: 5_000_000, payoutToken: null, fairBuyAmount: null})).toMatch(/does not match/);
    expect(vaultTermsProblem(corridor, {recipient: creator, amountMicro: 5_000_000, payoutToken: null, fairBuyAmount: null})).toMatch(/currency/);
  });
  it("accepts a conversion minimum close to today's rate", () => {
    expect(vaultTermsProblem(corridor, {recipient: creator, amountMicro: 5_000_000, payoutToken: "cNGN", fairBuyAmount: fair})).toBeNull();
  });
  it("refuses a near-zero conversion minimum, or one it cannot price", () => {
    expect(vaultTermsProblem({...corridor, minPayout: 1n}, {recipient: creator, amountMicro: 5_000_000, payoutToken: "cNGN", fairBuyAmount: fair})).toMatch(/far below today's rate/);
    expect(vaultTermsProblem(corridor, {recipient: creator, amountMicro: 5_000_000, payoutToken: "cNGN", fairBuyAmount: null})).toMatch(/cannot be checked/);
  });
});
