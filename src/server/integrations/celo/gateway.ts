import { type Hash } from "viem";
import { publicClient, assertCeloMainnet } from "./client";
export type SettlementStatus = "received" | "batched" | "confirmed" | "completed" | "failed";
export interface Settlement {id: string; status: SettlementStatus; fromAddress: string; toAddress: string; amount: string; createdAt: string; updatedAt: string}
/** Compatibility interface for the ledger: Celo settles to a real transaction hash, never a Gateway UUID. */
export async function getSettlement(id: string): Promise<Settlement> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("Expected a Celo transaction hash");
  await assertCeloMainnet();
  const receipt = await publicClient().getTransactionReceipt({hash: id as Hash}).catch((error: Error) => {
    if (error.name === "TransactionReceiptNotFoundError") return null;
    throw error;
  });
  return {id, status: !receipt ? "received" : receipt.status === "success" ? "confirmed" : "failed", fromAddress: "", toAddress: "", amount: "", createdAt: "", updatedAt: ""};
}
export async function resolveBatchTx(s: Settlement): Promise<string | null> {return s.status === "confirmed" ? s.id : null;}
