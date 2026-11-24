import { ExactEvmScheme } from "@x402/evm/exact/client";
import { selfHeaders } from "./self";
import { assertCeloMainnet } from "./client";
import { CELO } from "@/server/integrations/celo/config";
import type { AgentSigner } from "@/server/integrations/celo/signer";
import { getPublicText, publicUrl } from "@/server/security/public-http";

/** Two-phase Celo x402 buyer: get a quote, apply existing policy, then sign its exact amount. */

export interface PaymentRequirement {
  scheme: string;
  network: `${string}:${string}`;
  asset: string;
  amount: string; // atomic units (6 decimals)
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402Quote {
  url: string;
  method: "GET" | "POST";
  x402Version: number;
  resource: unknown;
  requirement: PaymentRequirement;
  amountMicro: number;
  payTo: string;
  description?: string;
}

export type QuoteResult = { kind: "quote"; quote: X402Quote } | { kind: "free"; status: number; data: unknown } | { kind: "unsupported"; reason: string };

export async function quote(url: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<QuoteResult> {
  try {
    if (publicUrl(url).protocol !== "https:") return { kind: "unsupported", reason: "Seller must use HTTPS" };
  } catch (e) { return { kind: "unsupported", reason: (e as Error).message }; }
  const method = opts.method ?? "GET";
  const res = await getPublicText(url, {
    method,
    headers: { "Content-Type": "application/json", ...await selfHeaders(method, url, opts.body !== undefined ? JSON.stringify(opts.body) : undefined) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    timeoutMs: 15_000,
    maxBytes: 1_000_000,
    redirect: "error",
  });
  if (res.status !== 402) {
    if (res.ok) return { kind: "free", status: res.status, data: jsonOrNull(res.text) };
    return { kind: "unsupported", reason: `HTTP ${res.status}` };
  }
  const header = res.headers["payment-required"];
  if (!header) return { kind: "unsupported", reason: "402 without PAYMENT-REQUIRED header" };
  const pr = jsonOrNull(Buffer.from(header, "base64").toString("utf-8")) as { x402Version?: number; resource?: { description?: string }; accepts?: PaymentRequirement[] } | null;
  const option = Array.isArray(pr?.accepts) ? pr.accepts.find((o) => o && o.scheme === "exact" && o.network === CELO.caip2 && o.extra?.name === "USDC" && o.extra?.version === "2" && o.extra?.assetTransferMethod !== "permit2") : undefined;
  if (pr?.x402Version !== 2) return {kind: "unsupported", reason: "Only x402 v2 is supported"};
  if (!option) return { kind: "unsupported", reason: `No exact USDC payment option on ${CELO.caip2}` };
  if (typeof option.asset !== "string" || option.asset.toLowerCase() !== CELO.usdc.toLowerCase()) return { kind: "unsupported", reason: "Seller requested an unexpected asset" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(option.payTo) || /^0x0{40}$/i.test(option.payTo) || !/^\d+$/.test(option.amount) || !Number.isSafeInteger(Number(option.amount)) || Number(option.amount) <= 0 || !Number.isSafeInteger(option.maxTimeoutSeconds) || option.maxTimeoutSeconds <= 0) return { kind: "unsupported", reason: "Invalid seller address or price" };
  return {
    kind: "quote",
    quote: {
      url,
      method,
      x402Version: pr!.x402Version ?? 2,
      resource: pr!.resource,
      requirement: option,
      amountMicro: Number(option.amount),
      payTo: option.payTo,
      description: pr!.resource?.description,
    },
  };
}

/** The authorization was sent, but nothing proves whether it settled. Keep the funds committed until a person checks. */
export class PaymentOutcomeUnknownError extends Error {}

export interface PayResult {
  status: number;
  data: unknown;
  settlementId: string;
  network: string;
  payer: string;
  amountMicro: number;
}

export async function pay(q: X402Quote, signer: AgentSigner, opts: { maxAmountMicro: number; body?: unknown }): Promise<PayResult> {
  if (publicUrl(q.url).protocol !== "https:") throw new Error("Seller must use HTTPS");
  if (q.x402Version !== 2) throw new Error("Only x402 v2 is supported");
  if (q.requirement.scheme !== "exact") throw new Error("Only exact payments are supported");
  if (q.requirement.network !== CELO.caip2 || q.requirement.asset.toLowerCase() !== CELO.usdc.toLowerCase() || q.requirement.extra?.name !== "USDC" || q.requirement.extra?.version !== "2" || q.requirement.extra?.assetTransferMethod === "permit2") throw new Error("Payment terms are not Celo mainnet USDC terms");
  if (q.amountMicro > opts.maxAmountMicro) throw new Error(`Quoted ${q.amountMicro} exceeds authorized ${opts.maxAmountMicro}`);
  if (!Number.isSafeInteger(opts.maxAmountMicro) || opts.maxAmountMicro <= 0 || !Number.isSafeInteger(q.amountMicro) || q.amountMicro <= 0 || !/^\d+$/.test(q.requirement.amount) || Number(q.requirement.amount) !== q.amountMicro || q.requirement.payTo.toLowerCase() !== q.payTo.toLowerCase()) throw new Error("Quoted payment amount or recipient is inconsistent");
  await assertCeloMainnet();
  const scheme = new ExactEvmScheme({ address: signer.address, signTypedData: (p) => signer.signTypedData(p as Parameters<typeof signer.signTypedData>[0]) });
  const payload = await scheme.createPaymentPayload(q.x402Version, {...q.requirement, extra: q.requirement.extra ?? {}});
  const header = Buffer.from(JSON.stringify({ ...payload, resource: q.resource, accepted: q.requirement })).toString("base64");
  const identity = await selfHeaders(q.method, q.url, opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  // From here a signed authorization has left this process. A lost response does not prove it was not settled.
  let res: Awaited<ReturnType<typeof getPublicText>>;
  try {
    res = await getPublicText(q.url, {
      method: q.method,
      headers: { "Content-Type": "application/json", "Payment-Signature": header, ...identity },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      timeoutMs: 30_000,
      maxBytes: 1_000_000,
      redirect: "error",
    });
  } catch {
    throw new PaymentOutcomeUnknownError("The seller did not answer after receiving a signed payment. It may still settle.");
  }
  const pr = res.headers["payment-response"];
  const settle = pr ? (jsonOrNull(Buffer.from(pr, "base64").toString("utf-8")) as { transaction?: string; network?: string; payer?: string; success?: boolean } | null) : undefined;
  if (!res.ok) {
    if (pr || res.status === 502 || res.status === 504) throw new PaymentOutcomeUnknownError(`The seller's response (${res.status}) does not show whether the signed payment settled.`);
    const err = (jsonOrNull(res.text) ?? {}) as { error?: string; reason?: string };
    throw new Error(`Payment failed (${res.status}): ${err.error ?? "seller error"}${err.reason ? ` — ${err.reason}` : ""}`);
  }
  if (!settle?.transaction || !/^0x[0-9a-fA-F]{64}$/.test(settle.transaction) || settle.success !== true || settle.network !== CELO.caip2 || settle.payer?.toLowerCase() !== signer.address.toLowerCase()) throw new PaymentOutcomeUnknownError("The seller accepted a signed payment but returned an invalid Celo settlement receipt.");
  return { status: res.status, data: jsonOrNull(res.text), settlementId: settle.transaction, network: settle.network ?? q.requirement.network, payer: settle.payer ?? signer.address, amountMicro: q.amountMicro };
}

const jsonOrNull = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
