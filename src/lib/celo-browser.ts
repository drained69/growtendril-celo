import { createPublicClient, createWalletClient, custom, http, type Abi, type Address, type EIP1193Provider, type Hash, type Hex } from "viem";
import { celo } from "viem/chains";

export const celoReader = createPublicClient({ chain: celo, transport: http("https://forno.celo.org", { timeout: 20_000, retryCount: 1 }) });

/** Connects the person's own wallet on Celo mainnet. GrowTendril never receives this key. */
export async function connectCelo() {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("Open this page in a browser with an EVM wallet.");
  const wallet = createWalletClient({ chain: celo, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("Connect a wallet");
  try {
    await wallet.switchChain({ id: celo.id });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await wallet.addChain({ chain: celo });
    await wallet.switchChain({ id: celo.id });
  }
  if (await wallet.getChainId() !== celo.id) throw new Error("Select Celo mainnet in your wallet");
  return { wallet, account };
}

/** Simulates first so a refused action costs nothing, then waits for Celo to confirm it. */
export async function sendCelo(params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; attribution: Hex | null }): Promise<Hash> {
  const { wallet, account } = await connectCelo();
  const { request } = await celoReader.simulateContract({ account, address: params.address, abi: params.abi, functionName: params.functionName, args: params.args as unknown[] });
  const hash = await wallet.writeContract({ ...request, ...(params.attribution ? { dataSuffix: params.attribution } : {}) } as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await celoReader.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("The transaction reverted on Celo.");
  return hash;
}

export function walletError(error: unknown): string {
  const value = error as { shortMessage?: string; message?: string; code?: number };
  if (value?.code === 4001) return "You declined the request in your wallet.";
  return (value?.shortMessage ?? value?.message ?? "The wallet action did not complete").slice(0, 220);
}
