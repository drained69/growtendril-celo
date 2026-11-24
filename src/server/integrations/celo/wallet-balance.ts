import { erc20Abi, type Address } from "viem";
import { CELO } from "./config";
import { assertCeloMainnet, publicClient } from "./client";
export async function arcUsdcBalanceMicro(address: string): Promise<number> {
  await assertCeloMainnet();
  const balance = await publicClient().readContract({address: CELO.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address as Address]});
  const micro = Number(balance);
  if (!Number.isSafeInteger(micro)) throw new Error("Balance exceeds supported precision");
  return micro;
}
export const celoUsdcBalanceMicro = arcUsdcBalanceMicro;
