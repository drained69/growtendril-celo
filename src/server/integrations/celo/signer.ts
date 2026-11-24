import type { Address, Hex } from "viem";
import { agentAccount } from "./client";
import { CELO, platformCustody } from "./config";
export interface AgentSigner {
  address: Address;
  kind: "celo_eoa";
  signTypedData(params: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; types: Record<string, Array<{name: string; type: string}>>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}
export interface SignableWallet {projectId?: string; provider: string; address: string | null; circleWalletId: string | null; blockchain?: string; dataMode?: string}
function usdcSigner(): AgentSigner {
  const account = agentAccount();
  return {address: account.address, kind: "celo_eoa", signTypedData: p => {
    if (p.domain.chainId !== CELO.chainId || p.domain.verifyingContract.toLowerCase() !== CELO.usdc.toLowerCase()) throw new Error("Only Celo USDC authorizations can be signed");
    return account.signTypedData(p);
  }};
}
export function signerFor(w: SignableWallet | null | undefined): AgentSigner | null {
  if (!w || w.provider !== "celo_eoa" || w.blockchain !== CELO.circleBlockchain || w.dataMode !== "LIVE" || !w.address || !platformCustody()) return null;
  if (w.projectId && w.projectId !== process.env.CELO_AGENT_PROJECT_ID) return null;
  if (agentAccount().address.toLowerCase() !== w.address.toLowerCase()) return null;
  return usdcSigner();
}
/**
 * Self Agent ID proves the key that signs a research request, so x402 research is paid by the
 * Self-verified agent key. In an Altana workspace that key is separate from the payout wallet.
 */
export function researchSignerFor(w: SignableWallet | null | undefined): AgentSigner | null {
  if (w?.provider !== "altana" && w?.provider !== "growth_vault") return signerFor(w);
  return platformCustody() && !!w.projectId && w.projectId === process.env.CELO_AGENT_PROJECT_ID ? usdcSigner() : null;
}
