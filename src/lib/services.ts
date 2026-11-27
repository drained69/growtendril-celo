/**
 * What GrowTendril charges for. Each service has one fixed price in USDC, deducted from the
 * workspace owner's prepaid balance when it runs. Browsing, settings, team and exports are free.
 * Safe to import from client components (no server dependencies).
 */
export type ServiceKey = "scan" | "creator_report" | "campaign_brief";

export const SERVICES: Record<ServiceKey, { name: string; priceUsdc: number; unit: string; blurb: string }> = {
  scan: {
    name: "Scan for customers",
    priceUsdc: 0.5,
    unit: "per scan",
    blurb: "Reads the places your customers talk, scores the people, trends and creators it finds, updates your growth plan and suggests tests. Each Autopilot run is one scan.",
  },
  creator_report: {
    name: "Creator report",
    priceUsdc: 0.75,
    unit: "per refresh",
    blurb: "Finds new creators, reads their profiles and rebuilds the report with how to reach them and a first message.",
  },
  campaign_brief: {
    name: "Campaign brief",
    priceUsdc: 0.5,
    unit: "per rewrite",
    blurb: "A fresh campaign brief for one creator. The first draft for every creator is free.",
  },
};

export const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];
export const servicePriceMicro = (k: ServiceKey) => Math.round(SERVICES[k].priceUsdc * 1_000_000);

/** Autopilot runs one scan per interval, so its cadence is also its daily cost. */
export const AUTOPILOT_SCANS_PER_DAY: Record<string, number> = { off: 0, hourly: 24, every_6h: 4, daily: 1 };
export function autopilotCostLabel(cadence: string): string {
  const scans = AUTOPILOT_SCANS_PER_DAY[cadence] ?? 0;
  if (!scans) return "Only when you start a scan";
  const perDay = scans * SERVICES.scan.priceUsdc;
  return `≈ ${perDay} USDC/day · ${(perDay * 30).toLocaleString("en-US")} USDC/month`;
}

/** Top-ups: any amount from the minimum; the presets are just shortcuts. */
export const MIN_TOPUP_USDC = 0.5;
export const MAX_TOPUP_USDC = 10_000;
export const TOPUP_PRESETS_USDC = [5, 10, 25, 50];
