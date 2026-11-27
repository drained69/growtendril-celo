import { servicePriceMicro, SERVICES } from "@/lib/services";

export interface GrowthStepState {
  hasProfile: boolean;
  hasMission: boolean;
  readySources: number;
  scanStatus: "queued" | "running" | null;
  hasScanned: boolean;
  creditMicro: number | null;
  pendingApprovals: number;
  opportunityHref?: string;
  permissions: { operate: boolean; approve: boolean; manageProfile: boolean; managePolicy: boolean; manageIntegrations: boolean; ownsCredit: boolean };
}

type Copy = { title: string; detail: string; label: string };
export type GrowthStep = Copy & ({ kind: "link"; href: string } | { kind: "scan" });

/** Guide the user with observed state. Wallet setup is only needed when paying people. */
export function nextGrowthStep(s: GrowthStepState): GrowthStep {
  if (s.pendingApprovals > 0) return { kind: "link", title: s.pendingApprovals === 1 ? "A payment is waiting for your OK" : `${s.pendingApprovals} payments are waiting for your OK`, detail: "Check who gets paid, how much and why, then say yes or no.", label: s.permissions.approve ? "Review payments" : "See payments", href: "/app/approvals" };
  if (s.scanStatus) return { kind: "link", title: s.scanStatus === "queued" ? "Your scan is about to start" : "Your scan is running", detail: "Suggestions appear here when it finishes. You can watch its progress in scan history.", label: "See scan progress", href: "/app/runs" };
  if (!s.permissions.operate) return { kind: "link", title: "Catch up on the growth plan", detail: "See what GrowTendril suggests and why. A Member, Admin or Owner can start scans and tests.", label: "See growth plan", href: "/app/plan" };
  if (!s.hasProfile) return { kind: "link", title: "Tell GrowTendril what you sell", detail: "Add what you sell and who it's for. That decides which conversations it looks for.", label: s.permissions.manageProfile ? "Add what you sell" : "Ask the owner", href: s.permissions.manageProfile ? "/app/settings#profile" : "/app/team" };
  if (!s.hasMission) return { kind: "link", title: "Choose your goal", detail: "Pick what you want more of and a monthly budget, so suggestions have a clear purpose.", label: s.permissions.managePolicy ? "Set a goal" : "Ask an admin", href: s.permissions.managePolicy ? "/onboarding?step=3" : "/app/team" };
  if (s.readySources === 0) return { kind: "link", title: "Choose where to look", detail: "GrowTendril needs at least one place your customers talk before a scan is worth paying for.", label: s.permissions.manageIntegrations ? "Choose where to look" : "Ask an admin", href: s.permissions.manageIntegrations ? "/app/integrations" : "/app/team" };
  if (s.opportunityHref) return { kind: "link", title: "Look at your best opportunity", detail: "Read what people said, then decide whether to try a small test.", label: "See opportunity", href: s.opportunityHref };
  if (s.creditMicro != null && s.creditMicro < servicePriceMicro("scan")) return { kind: "link", title: "Add credit for your next scan", detail: `A scan costs ${SERVICES.scan.priceUsdc} USDC (the GrowTendril fee). Credit is separate from the Payout account that pays creators.`, label: s.permissions.ownsCredit ? "Add credit" : "Ask the owner", href: s.permissions.ownsCredit ? "/billing" : "/app/team" };
  if (s.hasScanned) return { kind: "link", title: "Sharpen the search before your next test", detail: "The last scan didn't find a clear opportunity. Look at what it found and adjust your search words.", label: s.permissions.manageProfile ? "Change search words" : "See what we found", href: s.permissions.manageProfile ? "/app/settings#profile" : "/app/discover" };
  return { kind: "scan", title: "Find your first customers", detail: "GrowTendril reads the places your customers talk, ranks what it finds and brings back suggestions for you to review.", label: "Scan for customers" };
}
