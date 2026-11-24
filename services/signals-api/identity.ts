import type { RequestHandler } from "express";
import type { SelfAgentVerifier } from "@selfxyz/agent-sdk";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { createSelfVerifier } from "../../src/server/integrations/celo/self";

export interface IdentityLimits {
  capacity: number;
  refillPerSecond: number;
  maxConcurrent: number;
  maxConcurrentPerIp: number;
  verificationTimeoutMs: number;
  maxIpEntries: number;
  paidRequestsPerHumanPerDay: number;
}
const DEFAULT_LIMITS: IdentityLimits = {capacity: 60, refillPerSecond: 1, maxConcurrent: 8, maxConcurrentPerIp: 2, verificationTimeoutMs: 10_000, maxIpEntries: 2_048, paidRequestsPerHumanPerDay: 200};

/**
 * Authenticate before quoting or serving paid content. These guards bound a SINGLE process;
 * scaled deployments also need shared ingress/replay limits. Do not trust caller-supplied IP headers.
 */
export function selfIdentityGate(verifier: Pick<SelfAgentVerifier, "verify"> = createSelfVerifier(), overrides: Partial<IdentityLimits> = {}): RequestHandler {
  const limits = {...DEFAULT_LIMITS, ...overrides};
  const buckets = new Map<string, {tokens: number; at: number; active: number}>();
  const humans = new Map<string, {day: number; count: number}>();
  let active = 0;
  return async (req, res, next) => {
    const signature = req.get("x-self-agent-signature") ?? "";
    const timestamp = req.get("x-self-agent-timestamp") ?? "";
    const payment = req.get("payment-signature");
    if (req.originalUrl.length > 2_048 || signature.length > 1_024 || timestamp.length > 32 || (payment?.length ?? 0) > 16_384) {
      res.status(400).json({error: "Request exceeds identity input limits"}); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {res.status(405).json({error: "Method not supported"}); return;}
    // The supported service uses x402 v2. Do not leave legacy headers ambiguous across SDK versions.
    if (req.get("x-payment")) {res.status(400).json({error: "Use the x402 v2 Payment-Signature header"}); return;}
    if (!signature || !/^\d{10,16}$/.test(timestamp)) {res.status(401).json({error: "A valid Self Agent ID request is required"}); return;}
    const now = Date.now();
    // Express defaults trust proxy to false. A reverse proxy must enforce its own per-client limits.
    const ip = req.socket?.remoteAddress ?? "unknown";
    for (const [key, bucket] of buckets) {
      if (!bucket.active && now - bucket.at > Math.max(60_000, limits.capacity / limits.refillPerSecond * 1_000)) buckets.delete(key);
    }
    if (!buckets.has(ip) && buckets.size >= limits.maxIpEntries) {res.status(429).json({error: "Identity verification is busy"}); return;}
    const bucket = buckets.get(ip) ?? {tokens: limits.capacity, at: now, active: 0};
    bucket.tokens = Math.min(limits.capacity, bucket.tokens + (now - bucket.at) / 1_000 * limits.refillPerSecond);
    bucket.at = now; buckets.set(ip, bucket);
    if (bucket.tokens < 1 || active >= limits.maxConcurrent || bucket.active >= limits.maxConcurrentPerIp) {
      res.setHeader("Retry-After", "1"); res.status(429).json({error: "Identity verification rate limit reached"}); return;
    }
    bucket.tokens--; bucket.active++; active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Retain the concurrency slot until the RPC actually settles, even if the HTTP deadline expires.
      // Promise.race alone would release the slot and allow unlimited timed-out background RPC work.
      const verification = Promise.resolve().then(() => verifier.verify({signature, timestamp, method: req.method, url: req.originalUrl}))
        .finally(() => {active--; bucket.active--;});
      const result = await Promise.race([verification, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Identity verification deadline exceeded")), limits.verificationTimeoutMs);
      })]);
      if (!result.valid) {res.status(401).json({error: "A valid Self Agent ID request is required"}); return;}
      if (payment) {
        try {
          const payload = decodePaymentSignatureHeader(payment).payload as {authorization?: {from?: string}};
          if (payload.authorization?.from?.toLowerCase() !== result.agentAddress.toLowerCase()) {res.status(403).json({error: "Verified agent must be the payment payer"}); return;}
        } catch {res.status(400).json({error: "Invalid payment header"}); return;}
        // The quota follows the person's nullifier, so one human cannot multiply it with extra agents.
        const person = result.nullifier.toString();
        const day = Math.floor(Date.now() / 86_400_000);
        for (const [key, used] of humans) if (used.day !== day) humans.delete(key);
        const used = humans.get(person) ?? {day, count: 0};
        if (used.count >= limits.paidRequestsPerHumanPerDay) {res.setHeader("Retry-After", "3600"); res.status(429).json({error: "This person's verified agents reached today's paid research limit"}); return;}
        humans.set(person, {day, count: used.count + 1});
      }
      req.agent = {agentId: result.agentId, address: result.agentAddress, agentKey: result.agentKey, nullifier: result.nullifier, agentCount: result.agentCount};
      next();
    } catch {res.status(503).json({error: "Identity verification is temporarily unavailable"});}
    finally {clearTimeout(timer);}
  };
}
