import { erc20Abi, isAddress, parseUnits, type Address } from "viem";
import type { SignableWallet } from "./signer";
import { signerFor } from "./signer";
import { agentWalletClient, assertCeloMainnet } from "./client";
import { CELO, txExplorerUrl } from "./config";
import { celoUsdcBalanceMicro } from "./wallet-balance";
export interface ChainTxResult {state: "pending" | "success" | "error" | "noop"; txHash: string | null; explorerUrl: string | null; steps: {name: string; state: string; txHash?: string; explorerUrl?: string}[]}
export async function appKitSend(w: SignableWallet, p: {chain: string; to: string; amount: string}): Promise<ChainTxResult> {
  if (!signerFor(w) || p.chain !== "Celo") throw new Error("A Celo mainnet signer is required");
  if (!isAddress(p.to) || /^0x0{40}$/i.test(p.to) || !/^\d+(\.\d{1,6})?$/.test(p.amount)) throw new Error("Invalid recipient or USDC amount");
  const amount = parseUnits(p.amount, 6);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid payment amount");
  await assertCeloMainnet();
  const txHash = await agentWalletClient().writeContract({address: CELO.usdc, abi: erc20Abi, functionName: "transfer", args: [p.to as Address, amount]});
  return {state: "pending", txHash, explorerUrl: txExplorerUrl("Celo", txHash), steps: [{name: "Celo USDC transfer", state: "pending", txHash}]};
}
export async function appKitBridge(_w: SignableWallet, _p: {fromChain: string; toChain: string; amount: string}): Promise<ChainTxResult> {throw new Error("Cross-chain spending is disabled");}
export interface UnifiedBalance {totalMicro: number; byChain: {chain: string; label: string; micro: number}[]; source: "celo_rpc"}
export async function unifiedBalance(address: string): Promise<UnifiedBalance> {
  const micro = await celoUsdcBalanceMicro(address);
  return {totalMicro: micro, byChain: [{chain: "Celo", label: CELO.name, micro}], source: "celo_rpc"};
}
