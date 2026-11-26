import { Base64, Bytes, Hash, Hex, P256 } from "ox";

/**
 * Rebuilds a passkey's public key from its own signatures.
 *
 * An Altana wallet stores its passkey's public key in Altana's onchain registry only on its first
 * transaction, and the browser reveals a passkey's public key only when the passkey is created. A
 * wallet that has never sent a transaction therefore has no source for the key except its
 * signatures. Each P-256 signature yields two candidate public keys, and two signatures over
 * different challenges share exactly one, which is the passkey's key.
 */

export interface PasskeyAssertion {
  /** WebAuthn credential ID, base64url, as `PublicKeyCredential.id` returns it. */
  id: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** ASN.1 DER-encoded ECDSA signature, as WebAuthn returns it. */
  signature: Uint8Array;
  userHandle: Uint8Array | null;
}

/** Reads `r` and `s` from an ASN.1 DER ECDSA signature: 0x30 len 0x02 rlen r 0x02 slen s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const fail = () => { throw new Error("The passkey returned an unreadable signature."); };
  if (der[0] !== 0x30 || der[1] !== der.length - 2) fail();
  let offset = 2;
  const integer = () => {
    if (der[offset] !== 0x02) fail();
    const length = der[offset + 1];
    if (!length || length > 33 || offset + 2 + length > der.length) fail();
    const value = BigInt(Hex.fromBytes(der.slice(offset + 2, offset + 2 + length)));
    offset += 2 + length;
    return value;
  };
  const r = integer();
  const s = integer();
  if (offset !== der.length || r === 0n || s === 0n) fail();
  return { r, s };
}

/** The digest a WebAuthn authenticator signs: SHA-256(authenticatorData || SHA-256(clientDataJSON)). */
export function assertionPayload(a: Pick<PasskeyAssertion, "authenticatorData" | "clientDataJSON">): Hex.Hex {
  return Hash.sha256(Bytes.concat(a.authenticatorData, Hash.sha256(a.clientDataJSON, { as: "Bytes" })), { as: "Hex" });
}

/** Both public keys that could have produced this signature, in the flat x || y form Altana uses. */
export function candidatePublicKeys(a: Pick<PasskeyAssertion, "authenticatorData" | "clientDataJSON" | "signature">): Hex.Hex[] {
  const payload = assertionPayload(a);
  const { r, s } = parseDerSignature(a.signature);
  const keys: Hex.Hex[] = [];
  for (const yParity of [0, 1]) {
    try {
      const key = P256.recoverPublicKey({ payload, signature: { r, s, yParity } });
      keys.push(Hex.concat(Hex.fromNumber(key.x, { size: 32 }), Hex.fromNumber(key.y, { size: 32 })));
    } catch { /* This parity does not give a point on the curve. */ }
  }
  return keys;
}

/** The single public key every assertion agrees on. Refuses anything ambiguous. */
export function publicKeyFromAssertions(assertions: readonly PasskeyAssertion[]): Hex.Hex {
  if (assertions.length < 2) throw new Error("Two passkey signatures are needed to identify its public key.");
  if (new Set(assertions.map((a) => a.id)).size !== 1) throw new Error("The passkey changed between signatures. Use the same passkey each time.");
  let shared = new Set(candidatePublicKeys(assertions[0]).map((k) => k.toLowerCase()));
  for (const a of assertions.slice(1)) {
    const next = new Set(candidatePublicKeys(a).map((k) => k.toLowerCase()));
    shared = new Set([...shared].filter((k) => next.has(k)));
  }
  if (shared.size !== 1) throw new Error("The passkey's public key could not be identified from its signatures.");
  return [...shared][0] as Hex.Hex;
}

type GetCredential = (options: CredentialRequestOptions) => Promise<Credential | null>;

async function assertion(getCredential: GetCredential, credentialId?: BufferSource): Promise<PasskeyAssertion> {
  const credential = await getCredential({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : [],
      userVerification: "preferred",
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey selected.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    signature: new Uint8Array(response.signature),
    userHandle: response.userHandle ? new Uint8Array(response.userHandle) : null,
  };
}

/**
 * Asks the passkey to sign twice and returns its credential ID and public key, after checking that
 * it is the passkey created for `walletAddress` (Altana writes the wallet address into its user handle).
 */
export async function recoverPasskeyForWallet(walletAddress: string, getCredential: GetCredential = (o) => navigator.credentials.get(o)): Promise<{ id: string; publicKey: Hex.Hex }> {
  const first = await assertion(getCredential);
  const owner = first.userHandle?.length === 20 ? Hex.fromBytes(first.userHandle) : null;
  if (!owner || owner.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("This passkey belongs to a different wallet.");
  const second = await assertion(getCredential, new Uint8Array(Base64.toBytes(first.id)));
  return { id: first.id, publicKey: publicKeyFromAssertions([first, second]) };
}
