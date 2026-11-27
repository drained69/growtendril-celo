import type { Address } from "viem";
import { celoReader } from "@/lib/celo-browser";
import { recoverPasskeyForWallet } from "@/lib/passkey-recovery";

/** Browser-only helpers for an owner's Altana passkey wallet. */
export async function altana() {
  const sdk = await import("@altananetwork/sdk");
  return { sdk, client: sdk.createClient({ chains: [sdk.CELO], agentIdentity: { name: "GrowTendril Growth Operator", description: "Pays creators under limits its owner sets onchain.", endpoint: window.location.origin } }) };
}
/**
 * The owner's passkey signer. Altana's registry learns a wallet's passkey only on its first
 * transaction, so a wallet that has never transacted rebuilds the passkey from its signatures.
 */
export async function ownerFor(address: string) {
  const { sdk, client } = await altana();
  const fromSignatures = async () => {
    const { id, publicKey } = await recoverPasskeyForWallet(address);
    return { address, signer: sdk.signerFromPasskey({ kind: "webauthn", id, publicKey }) };
  };
  const code = await celoReader.getCode({ address: address as Address });
  if (!code || code === "0x") return { sdk, client, owner: await fromSignatures() };
  try {
    const owner = await client.recoverFromPasskey();
    if (owner.address.toLowerCase() !== address.toLowerCase()) throw new Error("This passkey belongs to a different wallet.");
    return { sdk, client, owner };
  } catch (e) {
    if (e instanceof Error && e.message.includes("no keys registered")) return { sdk, client, owner: await fromSignatures() };
    throw e;
  }
}
