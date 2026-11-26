import { describe, expect, it } from "vitest";
import { Bytes, Hash, Hex, P256 } from "ox";
import { candidatePublicKeys, parseDerSignature, publicKeyFromAssertions, recoverPasskeyForWallet, type PasskeyAssertion } from "../src/lib/passkey-recovery";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const WALLET = "0xfb319f53167f09eaaaece30bab85e81bb8ed0958";

const minimal = (n: bigint) => {
  const bytes = Bytes.fromHex(Hex.fromNumber(n));
  return bytes[0] & 0x80 ? Bytes.concat(new Uint8Array([0]), bytes) : bytes;
};
/** ASN.1 DER, the encoding WebAuthn authenticators return. */
const der = (r: bigint, s: bigint) => {
  const rb = minimal(r), sb = minimal(s);
  return Bytes.concat(new Uint8Array([0x30, rb.length + sb.length + 4, 0x02, rb.length]), rb, new Uint8Array([0x02, sb.length]), sb);
};
const flat = (privateKey: Hex.Hex) => {
  const key = P256.getPublicKey({ privateKey });
  return Hex.concat(Hex.fromNumber(key.x, { size: 32 }), Hex.fromNumber(key.y, { size: 32 })).toLowerCase();
};

/** What a platform authenticator returns for one sign-in with this key. */
function signIn(privateKey: Hex.Hex, opts: { id?: string; challenge?: Uint8Array; userHandle?: Uint8Array | null; highS?: boolean } = {}): PasskeyAssertion {
  const authenticatorData = Bytes.concat(Hash.sha256(Bytes.fromString("celo.growtendril.xyz"), { as: "Bytes" }), new Uint8Array([0x05, 0, 0, 0, 7]));
  const challenge = Hex.fromBytes(opts.challenge ?? crypto.getRandomValues(new Uint8Array(32)));
  const clientDataJSON = Bytes.fromString(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://celo.growtendril.xyz" }));
  const payload = Hash.sha256(Bytes.concat(authenticatorData, Hash.sha256(clientDataJSON, { as: "Bytes" })));
  const { r, s } = P256.sign({ payload, privateKey });
  return { id: opts.id ?? "cred-1", authenticatorData, clientDataJSON, signature: der(r, opts.highS ? N - s : s), userHandle: opts.userHandle === undefined ? Bytes.fromHex(WALLET) : opts.userHandle };
}

describe("passkey public-key recovery", () => {
  it("recovers the exact public key from two signatures, for many keys and both s forms", () => {
    for (let i = 0; i < 25; i++) {
      const privateKey = P256.randomPrivateKey();
      const key = publicKeyFromAssertions([signIn(privateKey, { highS: i % 2 === 0 }), signIn(privateKey, { highS: i % 3 === 0 })]);
      expect(key).toBe(flat(privateKey));
      expect(key).toMatch(/^0x[0-9a-f]{128}$/);
    }
  });

  it("finds the key among each signature's two candidates", () => {
    const privateKey = P256.randomPrivateKey();
    const candidates = candidatePublicKeys(signIn(privateKey)).map((k) => k.toLowerCase());
    expect(candidates).toContain(flat(privateKey));
    expect(candidates.length).toBeLessThanOrEqual(2);
  });

  it("refuses a single signature, mixed passkeys and identical signatures", () => {
    const a = P256.randomPrivateKey(), b = P256.randomPrivateKey();
    expect(() => publicKeyFromAssertions([signIn(a)])).toThrow(/Two passkey signatures/);
    expect(() => publicKeyFromAssertions([signIn(a, { id: "one" }), signIn(b, { id: "two" })])).toThrow(/changed between signatures/);
    // Two signatures from different keys under one ID share no candidate.
    expect(() => publicKeyFromAssertions([signIn(a), signIn(b)])).toThrow(/could not be identified/);
    // The same signature twice leaves both candidates, which is ambiguous.
    const same = signIn(a);
    expect(() => publicKeyFromAssertions([same, same])).toThrow(/could not be identified/);
  });

  it("rejects malformed DER signatures", () => {
    expect(() => parseDerSignature(new Uint8Array([0x31, 0x02, 0x02, 0x00]))).toThrow(/unreadable/);
    expect(() => parseDerSignature(Bytes.concat(der(5n, 7n), new Uint8Array([0])))).toThrow(/unreadable/);
    expect(parseDerSignature(der(2n ** 255n + 3n, 9n))).toEqual({ r: 2n ** 255n + 3n, s: 9n });
  });
});

describe("recovering the passkey for a wallet", () => {
  const credential = (a: PasskeyAssertion) => ({
    id: a.id,
    response: { authenticatorData: a.authenticatorData.buffer, clientDataJSON: a.clientDataJSON.buffer, signature: a.signature.buffer, userHandle: a.userHandle ? a.userHandle.buffer : null },
  }) as unknown as Credential;

  it("signs twice with the same passkey and returns its credential ID and public key", async () => {
    const privateKey = P256.randomPrivateKey();
    const requests: CredentialRequestOptions[] = [];
    const getCredential = async (options: CredentialRequestOptions) => {
      requests.push(options);
      return credential(signIn(privateKey, { id: "bTEtYk1QdUFxcFc", challenge: new Uint8Array(options.publicKey!.challenge as ArrayBuffer) }));
    };
    await expect(recoverPasskeyForWallet(WALLET.toUpperCase().replace("0X", "0x"), getCredential)).resolves.toEqual({ id: "bTEtYk1QdUFxcFc", publicKey: flat(privateKey) });
    expect(requests).toHaveLength(2);
    expect(requests[0].publicKey!.allowCredentials).toEqual([]);
    expect(requests[1].publicKey!.allowCredentials).toHaveLength(1);
    expect(Hex.fromBytes(requests[1].publicKey!.allowCredentials![0].id as Uint8Array)).toBe(Hex.fromBytes(new Uint8Array([0x6d, 0x31, 0x2d, 0x62, 0x4d, 0x50, 0x75, 0x41, 0x71, 0x70, 0x57])));
  });

  it("refuses a passkey made for another wallet, or none at all", async () => {
    const privateKey = P256.randomPrivateKey();
    const other = async () => credential(signIn(privateKey, { userHandle: Bytes.fromHex(`0x${"1".repeat(40)}`) }));
    await expect(recoverPasskeyForWallet(WALLET, other)).rejects.toThrow(/different wallet/);
    const missing = async () => credential(signIn(privateKey, { userHandle: null }));
    await expect(recoverPasskeyForWallet(WALLET, missing)).rejects.toThrow(/different wallet/);
    await expect(recoverPasskeyForWallet(WALLET, async () => null)).rejects.toThrow(/No passkey selected/);
  });
});
