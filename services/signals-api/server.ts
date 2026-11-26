/** Self-verified paid research on Celo mainnet. The identity gate runs before the payment gate. */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress } from "viem";
import { pathToFileURL } from "node:url";
import { CELO } from "../../src/server/integrations/celo/config";
import { selfIdentityGate } from "./identity";
import { companyIntel, narrativePulse, textParam, type ResearchResponse } from "./research";

const PORT = Number(process.env.SIGNALS_API_PORT || process.env.PORT || 4021);
const SELLER = process.env.SIGNALS_SELLER_ADDRESS;
const app = express();
app.disable("x-powered-by");
const PRICES = {company: "5000", creator: "10000", narrative: "2500"};
app.get("/", (_req, res) => res.json({name: "GrowTendril Signals", network: CELO.caip2,
  identity: "Self Agent ID required before payment", seller: SELLER ?? null,
  configured: !!SELLER && !!process.env.X402_API_KEY,
  endpoints: ["/v1/company-intel?company=<name>", "/v1/narrative-pulse?term=<term>"]}));

if (SELLER && process.env.X402_API_KEY) {
  app.use("/v1", selfIdentityGate());
  const facilitator = new HTTPFacilitatorClient({url: "https://api.x402.celo.org", createAuthHeaders: async () => {
    const h = {"X-API-Key": process.env.X402_API_KEY!}; return {verify: h, settle: h, supported: h};
  }});
  const resource = new x402ResourceServer(facilitator).register(CELO.caip2, new ExactEvmScheme());
  const route = (amount: string) => ({accepts: [{scheme: "exact" as const, network: CELO.caip2, payTo: getAddress(SELLER), price: {amount, asset: CELO.usdc, extra: {name: "USDC", version: "2"}}}], description: "Self-verified company research and public source evidence"});
  app.use(paymentMiddleware({"GET /v1/company-intel": route(PRICES.company), "GET /v1/narrative-pulse": route(PRICES.narrative)}, resource));
} else {
  app.use("/v1", (_req, res) => {res.status(503).json({error: "Configure SIGNALS_SELLER_ADDRESS and X402_API_KEY to enable verified payments"});});
}
type Paid = express.Request;
const receipt = (req: Paid) => ({network: CELO.caip2, verifiedAgent: req.agent?.address ?? null, agentId: req.agent?.agentId.toString() ?? null});
// A non-2xx response is not settled by the x402 middleware, so outages and bad input are never charged.
const send = (req: Paid, res: express.Response, result: ResearchResponse) =>
  result.status === 200 ? res.json({...result.body, payment: receipt(req)}) : res.status(result.status).json(result.body);

app.get("/v1/company-intel", async (req: Paid, res) => {
  send(req, res, await companyIntel(req.query));
});

app.get("/v1/creator-audience", async (req: Paid, res) => {
  const handle = textParam(req.query.handle);
  if (!handle) return res.status(400).json({ error: "handle is required (1-120 characters)" });
  // No legitimate public source exposes follower demographics; say so instead of inventing them.
  res.json({ handle, dataMode: "LIVE", available: false, reason: "No permitted public source for audience composition of this creator", payment: receipt(req) });
});

app.get("/v1/narrative-pulse", async (req: Paid, res) => {
  send(req, res, await narrativePulse(req.query));
});

export { app };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = app.listen(PORT);
  server.on("listening", () => console.log(`GrowTendril Signals on port ${PORT}: Celo mainnet, Self identity gate, x402`));
  server.on("error", () => { console.error("Signals could not open its listening port"); process.exitCode = 1; });
}
