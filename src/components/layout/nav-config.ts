import { Map as MapIcon, Activity, Bot, Building2, ClipboardList, Coins, FlaskConical, Flag, Gem, LayoutDashboard, Megaphone, Network, Newspaper, Plug, Radar, Receipt, Settings, ShieldCheck, Target, TrendingUp, Users, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "approvals";
  keywords?: string;
  /** Additional views remain available without competing with the daily workflow. */
  secondary?: boolean;
}

export const NAV: { section: string | null; items: NavItem[] }[] = [
  {
    section: null,
    items: [
      { href: "/app", label: "Overview", icon: LayoutDashboard, keywords: "home dashboard mission" },
      { href: "/app/brief", label: "Daily brief", icon: Newspaper, keywords: "report summary today" },
    ],
  },
  {
    section: "Intelligence",
    items: [
      { href: "/app/discover", label: "Discover", icon: Radar, keywords: "feed posts sources research" },
      { href: "/app/customers", label: "Customers", icon: Building2, keywords: "companies intent leads" },
      { href: "/app/narratives", label: "Trends", icon: TrendingUp, keywords: "narratives topics market", secondary: true },
      { href: "/app/kols", label: "Creators", icon: Megaphone, keywords: "kol influencers voices" },
      { href: "/app/kols/report", label: "Creator report", icon: ClipboardList, keywords: "influencers outreach contact creators report export", secondary: true },
      { href: "/app/graph", label: "Growth graph", icon: Network, secondary: true },
    ],
  },
  {
    section: "Growth",
    items: [
      { href: "/app/opportunities", label: "Opportunities", icon: Target, secondary: true },
      { href: "/app/plan", label: "Growth plan", icon: MapIcon, keywords: "plan campaigns content partnerships outreach bounties strategy" },
      { href: "/app/missions", label: "Goal", icon: Flag, keywords: "mission goal monthly budget" },
      { href: "/app/experiments", label: "Tests", icon: FlaskConical, keywords: "experiments tests" },
      { href: "/app/campaigns", label: "Campaigns", icon: Megaphone, keywords: "creator campaigns rewards join link" },
      { href: "/app/customer-value", label: "Customer value", icon: Gem, keywords: "cohorts ltv cac cpa payback revenue repeat activation roi", secondary: true },
    ],
  },
  {
    section: "Money",
    items: [
      { href: "/app/wallet", label: "Payout account", icon: Wallet, keywords: "wallet balance usdc deposit contract pay people" },
      { href: "/app/approvals", label: "Approvals", icon: ShieldCheck, badge: "approvals", keywords: "inbox spend ok" },
      { href: "/billing", label: "Billing", icon: Coins, keywords: "credit top up scans fee" },
      { href: "/app/activity", label: "Activity", icon: Activity, keywords: "payments transactions onchain x402 settlements", secondary: true },
      { href: "/app/receipts", label: "Receipts", icon: Receipt, keywords: "decisions audit proof", secondary: true },
      { href: "/app/runs", label: "Scan history", icon: Bot, keywords: "agent runs jobs autopilot logs", secondary: true },
    ],
  },
  {
    section: "Workspace",
    items: [
      { href: "/app/integrations", label: "Integrations", icon: Plug, keywords: "api keys x reddit youtube github webhook" },
      { href: "/app/team", label: "Team", icon: Users, keywords: "members invite roles", secondary: true },
      { href: "/app/settings", label: "Settings", icon: Settings, keywords: "budget limits profile ideal customer autopilot" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

/** The most specific nav item that contains this path, used by breadcrumbs. */
export function navMatch(path: string): NavItem | null {
  return ALL_NAV.find((n) => n.href === path) ?? [...ALL_NAV].sort((a, b) => b.href.length - a.href.length).find((n) => n.href !== "/app" && path.startsWith(`${n.href}/`)) ?? null;
}
