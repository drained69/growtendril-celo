import { randomBytes } from "node:crypto";
import { isAddress, isHex, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { CELO } from "./config";
import { PAYOUT_TOKENS, TEXTILE_REACTOR, USDT, type PayoutToken } from "./corridors";

const API = "https://api.textilecredit.com/v2";
const atomic = z.string().regex(/^\d{1,78}$/);
const tx = z.object({to: z.string(), data: z.string(), value: z.union([z.string(), z.number()]), chainId: z.number().optional()});
const firmQuote = z.object({
  rfqId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(512).optional(),
  status: z.string(),
  reason: z.string().optional(),
  retryAfterMs: z.number().optional(),
  attributionSuffix: z.string().nullable().optional(),
  quote: z.object({sellAmount: atomic, buyAmount: atomic, feeAmount: atomic, takerPays: atomic, rateRay: atomic, expiresAt: z.string(), reactor: z.string(), taker: z.string()}).optional(),
  transactions: z.object({approval: tx.optional(), swap: tx}).optional(),
});

export class TextileError extends Error {}
export interface CorridorPreview {status: "preview" | "no_quote"; buyAmount: string | null; feeAmount: string | null; rateRay: string | null; reason: string | null}
export interface CorridorQuote {rfqId: string; claimToken: string | null; takerPays: bigint; buyAmount: bigint; feeAmount: bigint; rateRay: string; expiresAt: number; swap: {to: Address; data: Hex}; tagged: boolean}
export type TakerProofSigner = (challenge: {domain: {name: string; version: string; chainId: number}; types: {TakerControl: {name: string; type: string}[]}; primaryType: "TakerControl"; message: {taker: Address; chainId: bigint; nonce: Hex; issuedAt: bigint}}) => Promise<Hex>;

const apiKey = () => process.env.TEXTILE_API_KEY?.trim() || null;
const requestBody = (token: PayoutToken, sellMicro: bigint) => ({chainId: CELO.chainId, sellToken: USDT.address, buyToken: PAYOUT_TOKENS[token].address, sellAmount: sellMicro.toString()});

async function send(path: string, body: unknown, timeoutMs: number, headers: Record<string, string> = {}) {
  const key = apiKey();
  const response = await fetch(`${API}${path}`, {method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: {"Content-Type": "application/json", ...(key ? {Authorization: `Bearer ${key}`} : {}), ...headers}, body: JSON.stringify(body)});
  const json = await response.json().catch(() => null) as {data?: unknown; error?: {code?: string; message?: string; details?: {reason?: string}}} | null;
  return {status: response.status, ok: response.ok, data: json?.data, reason: json?.error?.details?.reason ?? json?.error?.code ?? null};
}

/** Free indicative price. Nothing is signed or reserved, and it can differ from a firm quote. */
export async function previewCorridor(token: PayoutToken, sellMicro: bigint): Promise<CorridorPreview> {
  const r = await send("/rfq/preview", requestBody(token, sellMicro), 15_000);
  if (!r.ok) throw new TextileError("Textile FX could not price this corridor right now.");
  const d = (r.data ?? {}) as {status?: string; buyAmount?: string; feeAmount?: string; rateRay?: string; reason?: string};
  if (d.status === "preview" && atomic.safeParse(d.buyAmount).success) return {status: "preview", buyAmount: d.buyAmount!, feeAmount: d.feeAmount ?? null, rateRay: d.rateRay ?? null, reason: null};
  return {status: "no_quote", buyAmount: null, feeAmount: null, rateRay: null, reason: d.reason ?? "no_valid_quote"};
}

/** Every value that decides where funds go is checked here before anything is signed. */
export function validateCorridorQuote(data: unknown, expected: {sellMicro: bigint; taker: Address; now?: number}): CorridorQuote {
  const parsed = firmQuote.safeParse(data);
  if (!parsed.success) throw new TextileError("Textile FX returned an unreadable quote.");
  const d = parsed.data;
  if (d.status === "no_quote") throw new TextileError(`No Textile FX maker can fill this payout right now (${d.reason ?? "no quote"}).`);
  if (d.status !== "quoted" || !d.quote || !d.transactions) throw new TextileError("Textile FX did not return a firm quote.");
  const {quote, transactions: {swap}} = d;
  const takerPays = BigInt(quote.takerPays);
  const buyAmount = BigInt(quote.buyAmount);
  const expiresAt = Date.parse(quote.expiresAt);
  const same = (a: string, b: string) => isAddress(a) && a.toLowerCase() === b.toLowerCase();
  if (!same(quote.reactor, TEXTILE_REACTOR) || !same(swap.to, TEXTILE_REACTOR)) throw new TextileError("The quote targets an unexpected settlement contract.");
  if (!same(quote.taker, expected.taker)) throw new TextileError("The quote is bound to a different wallet.");
  if (swap.chainId !== undefined && swap.chainId !== CELO.chainId) throw new TextileError("The quote is not for Celo mainnet.");
  if (BigInt(swap.value) !== 0n || !isHex(swap.data) || swap.data.length < 10) throw new TextileError("The quote contains an invalid swap transaction.");
  if (takerPays <= 0n || takerPays > expected.sellMicro || buyAmount <= 0n) throw new TextileError("The quote does not match the approved amount.");
  if (!Number.isFinite(expiresAt) || expiresAt <= (expected.now ?? Date.now())) throw new TextileError("The quote expired before it could be used.");
  return {rfqId: d.rfqId, claimToken: d.claimToken ?? null, takerPays, buyAmount, feeAmount: BigInt(quote.feeAmount), rateRay: quote.rateRay, expiresAt, swap: {to: TEXTILE_REACTOR, data: swap.data}, tagged: !!d.attributionSuffix};
}

/** Firm quote bound to `taker`. A partner key also lets a smart wallet quote and adds the attribution tag. */
export async function requestCorridorQuote(p: {token: PayoutToken; sellMicro: bigint; taker: Address; signProof?: TakerProofSigner}): Promise<CorridorQuote> {
  const code = process.env.CELO_ATTRIBUTION_CODE;
  const base = {...requestBody(p.token, p.sellMicro), taker: p.taker, ...(apiKey() && code ? {includeAttribution: true, builderCodes: [code]} : {})};
  if (!apiKey() && !p.signProof) throw new TextileError("Add a Textile API key to convert from a smart wallet.");
  let r = await send("/rfq/request", base, 75_000);
  if (r.status === 401 && r.reason === "proof_of_control_required" && p.signProof) {
    const nonce = toHex(randomBytes(32));
    const issuedAt = Date.now();
    const signature = await p.signProof({
      domain: {name: "Textile Taker Control", version: "1", chainId: CELO.chainId},
      types: {TakerControl: [{name: "taker", type: "address"}, {name: "chainId", type: "uint256"}, {name: "nonce", type: "bytes32"}, {name: "issuedAt", type: "uint256"}]},
      primaryType: "TakerControl",
      message: {taker: p.taker, chainId: BigInt(CELO.chainId), nonce, issuedAt: BigInt(issuedAt)},
    });
    r = await send("/rfq/request", {...base, takerProof: {nonce, issuedAt, signature}}, 75_000);
  }
  if (!r.ok) throw new TextileError(r.status === 429 ? "Textile FX is rate limiting quotes. Try again shortly." : "Textile FX could not quote this payout.");
  return validateCorridorQuote(r.data, {sellMicro: p.sellMicro, taker: p.taker});
}

/** A courtesy report: Textile reconciles fills from the chain whether or not this succeeds. */
export async function reportCorridorTx(quote: Pick<CorridorQuote, "rfqId" | "claimToken">, txHash: Hex) {
  await send(`/rfq/${encodeURIComponent(quote.rfqId)}/submit`, {txHash}, 10_000, quote.claimToken ? {"X-Rfq-Claim": quote.claimToken} : {}).catch(() => undefined);
}
