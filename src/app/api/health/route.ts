import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { platformCustody } from "@/server/integrations/celo/config";
import { aiProvider } from "@/server/integrations/llm";
import { emailConfigured } from "@/server/integrations/email";
import { billingMode } from "@/server/domain/billing";
import { googleConfigured } from "@/server/auth/google";
import { CELO } from "@/server/integrations/celo/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    // Payment configuration is reported separately from database liveness.
    return NextResponse.json({ ok: true, custody: platformCustody(), network: CELO.caip2, attributionConfigured: !!process.env.CELO_ATTRIBUTION_CODE, selfEnabled: process.env.SELF_AGENT_ENABLED === "1", ai: aiProvider() ?? false, email: emailConfigured(), billing: billingMode(), google: googleConfigured() });
  } catch (error) {
    console.error("[GrowTendril health] database unavailable", error);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
