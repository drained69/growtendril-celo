import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/lib/ids";
import { CELO } from "./config";
import { quote } from "./x402";
import { safeErrorMessage } from "@/server/security/safe-error";
export interface DiscoveredService {resourceUrl: string; vendor: string; category: string | null; description: string; method: string; priceMicro: number | null; network: string | null; payableOnCelo: boolean}
/** Only explicitly configured URLs are requested; prices/recipients come from live Celo 402 quotes. */
export async function searchMarketplace(query: string, opts: {category?: string; limit?: number} = {}): Promise<DiscoveredService[]> {
  const urls = [...new Set((process.env.CELO_RESEARCH_URLS ?? "").split(",").map(s => s.trim()).filter(Boolean))].slice(0, 30);
  const out: DiscoveredService[] = [];
  for (const url of urls) {
    const result = await quote(url);
    if (result.kind !== "quote") continue;
    const q = result.quote;
    out.push({resourceUrl: url, vendor: new URL(url).hostname, category: "research", description: q.description ?? "Paid research on Celo", method: q.method, priceMicro: q.amountMicro, network: CELO.caip2, payableOnCelo: true});
  }
  // Caller uses category queries to refresh all configured research services.
  return out.slice(0, opts.limit ?? 20);
}
export async function upsertService(db: DB, svc: { vendor: string; vendorSource: "celo_x402" | "growthos"; vendorCategory?: string | null; website?: string | null; resourceUrl: string; method: string; description: string; category?: string | null; priceMicro?: number | null; network?: string | null; payTo?: string | null; capabilities: string[] }) {
  const [v] = await db
    .insert(s.vendors)
    .values({ id: newId(), name: svc.vendor, category: svc.vendorCategory ?? null, website: svc.website ?? null, source: svc.vendorSource })
    .onConflictDoUpdate({ target: s.vendors.name, set: { category: svc.vendorCategory ?? null } })
    .returning({ id: s.vendors.id });
  const [row] = await db
    .insert(s.services)
    .values({ id: newId(), vendorId: v.id, resourceUrl: svc.resourceUrl, method: svc.method, description: svc.description, category: svc.category ?? null, priceMicro: svc.priceMicro ?? null, network: svc.network ?? null, payTo: svc.payTo ?? null, capabilities: svc.capabilities })
    .onConflictDoUpdate({ target: s.services.resourceUrl, set: { priceMicro: svc.priceMicro ?? null, network: svc.network ?? null, description: svc.description, capabilities: svc.capabilities, lastSeenAt: new Date() } })
    .returning();
  return row;
}

/** Map marketplace categories/text to the capabilities GrowTendril needs. */
export function inferCapabilities(text: string): string[] {
  const t = text.toLowerCase();
  const caps: string[] = [];
  if (/compan|enrich|firmograph|business|funding|hiring/.test(t)) caps.push("company_enrichment");
  if (/social|twitter|x\.com|creator|influenc|audience/.test(t)) caps.push("creator_audience");
  if (/trend|news|sentiment|narrative|search/.test(t)) caps.push("narrative_pulse");
  if (/research|web search|crawl/.test(t)) caps.push("research");
  return caps;
}

/** Refresh the catalog from the configured Celo research catalog. Returns how many Celo-payable services were found. */
export async function refreshMarketplace(db: DB, queries = ["company data", "web search research", "social analytics", "news"]): Promise<{ found: number; celoPayable: number; error?: string }> {
  let found = 0;
  let celoPayable = 0;
  try {
    for (const q of queries) {
      for (const svc of await searchMarketplace(q, { limit: 15 })) {
        found++;
        if (svc.payableOnCelo) celoPayable++;
        await upsertService(db, {
          vendor: svc.vendor,
          vendorSource: "celo_x402",
          vendorCategory: svc.category,
          resourceUrl: svc.resourceUrl,
          method: svc.method,
          description: svc.description,
          category: svc.category,
          priceMicro: svc.priceMicro,
          network: svc.network,
          capabilities: inferCapabilities(`${svc.category ?? ""} ${svc.description} ${svc.vendor}`),
        });
      }
    }
    return { found, celoPayable };
  } catch (e) {
    return { found, celoPayable, error: safeErrorMessage(e) };
  }
}

export async function servicesWithCapability(db: DB, cap: string) {
  const rows = await db.select({ svc: s.services, vendor: s.vendors }).from(s.services).innerJoin(s.vendors, eq(s.services.vendorId, s.vendors.id));
  return rows.filter((r) => r.svc.capabilities.includes(cap));
}
