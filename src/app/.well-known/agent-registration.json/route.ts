import { CELO, IDENTITY_REGISTRY, parseAgentId } from "@/server/integrations/celo/config";
export const dynamic = "force-dynamic";
export async function GET() {
  const origin = new URL(process.env.APP_URL || "https://celo.growtendril.xyz").origin;
  const id = parseAgentId(process.env.CELO_AGENT_ID);
  return Response.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "GrowTendril — Celo Growth Operator",
    description: "Find demand, coordinate creator campaigns, buy verified research and measure growth outcomes under human-controlled spending policies.",
    image: `${origin}/logo.svg`,
    services: [{name: "web", endpoint: origin}, ...(process.env.SIGNALS_PUBLIC_URL ? [{name: "research", endpoint: process.env.SIGNALS_PUBLIC_URL}] : [])],
    active: id !== null, x402Support: !!process.env.SIGNALS_PUBLIC_URL && !!process.env.X402_API_KEY,
    registrations: id !== null ? [{agentId: id, agentRegistry: `${CELO.caip2}:${IDENTITY_REGISTRY}`}] : [],
    supportedTrust: ["reputation"],
  });
}
