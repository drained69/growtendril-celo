import Link from "next/link";
import { Sparkles } from "lucide-react";
import { AUDIENCE_LABEL, type Audience } from "@/server/domain/intel/market-taxonomy";
import { fmtUsdc } from "@/lib/money";
import { resetLabel } from "@/lib/budget";
import { Badge, Card, CardBody, CardFooter, CardHeader, KeyValue, LinkButton } from "@/components/ui";

/** "Here's what GrowTendril set up from your website" — every inference, with a way to change it. */
export function SetupSummary({
  website,
  profile,
  icps,
  mission,
  largestPaymentMicro,
  scanning,
  scanStatus,
  lowCredit,
  autopilot,
}: {
  website: string | null;
  profile: { category: string; audience: string; targetUsers: string[]; keywords: string[]; competitors: string[]; generatedBy: string; crawledSources: { url: string; ok: boolean }[] };
  icps: { title: string; tier: string }[];
  mission: { name: string; goalDescription: string; budgetMicro: number; endsAt: Date } | null;
  largestPaymentMicro?: number | null;
  scanning: boolean;
  scanStatus?: string | null;
  /** Billing is on and the balance can't cover a scan, so the first one is waiting. */
  lowCredit?: boolean;
  /** e.g. "Daily · ≈ 1 USDC/day" */
  autopilot?: string;
}) {
  let host = "your description";
  try { if (website) host = new URL(website).hostname.replace(/^www\./, ""); } catch { /* Older workspaces may have an incomplete website URL. */ }
  const read = profile.crawledSources.filter((c) => c.ok).length;
  const chips = (xs: string[]) => (xs.length ? <span className="flex flex-wrap justify-end gap-1">{xs.map((x, ix) => <Badge key={`${ix}:${x}`} tone="muted">{x}</Badge>)}</span> : <span className="text-ink-4">none found</span>);
  return (
    <Card>
      <CardHeader
        title={`Set up from ${host}`}
        description={`${read} page${read === 1 ? "" : "s"} read · ${["claude", "gemini"].includes(profile.generatedBy) ? "written by AI" : "built from your site's own wording"}. ${scanStatus === "queued" ? "Your first scan is waiting to start." : scanning ? "Your first scan is running." : lowCredit ? "Add credit to run your first scan." : "Your scan's results are in scan history."}`}
        icon={<Sparkles />}
        action={<LinkButton href="/app/settings#profile" size="xs">Review profile</LinkButton>}
      />
      <CardBody>
        <KeyValue
          items={[
            { k: "What you sell", v: profile.category },
            { k: "Customers", v: AUDIENCE_LABEL[profile.audience as Audience] ?? profile.audience },
            { k: "Who it's for", v: chips(profile.targetUsers.slice(0, 4)) },
            { k: "Ideal customers", v: chips(icps.map((i) => i.title)) },
            { k: "Searching for", v: chips(profile.keywords.slice(0, 6)) },
            { k: "Competitors", v: chips(profile.competitors.slice(0, 5)) },
            ...(mission ? [{ k: "First goal", v: mission.goalDescription }, { k: "Monthly budget", v: `${fmtUsdc(mission.budgetMicro)} a month · starts again on ${resetLabel(mission.endsAt)}` }] : []),
            ...(largestPaymentMicro ? [{ k: "Largest single payment", v: fmtUsdc(largestPaymentMicro) }] : []),
            { k: "What needs your OK", v: "Every payment to a person. GrowTendril asks you first, always." },
            ...(autopilot ? [{ k: "Autopilot", v: <Link href="/app/settings#autopilot" className="underline-offset-2 hover:underline">{autopilot}</Link> }] : []),
          ]}
        />
      </CardBody>
      <CardFooter>
        <span>Is this right? Check the goal and budget before you start.</span>
        <span className="flex flex-wrap gap-3">
          <Link href="/onboarding?step=3" className="hover:text-ink">Change goal</Link>
          <Link href="/app/settings#budget" className="hover:text-ink">Change budget</Link>
          <Link href="/app" className="font-medium text-ink-2 hover:text-ink">Looks right →</Link>
        </span>
      </CardFooter>
    </Card>
  );
}
