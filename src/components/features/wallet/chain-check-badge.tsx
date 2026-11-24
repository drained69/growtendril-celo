import { Badge } from "@/components/ui";

const CHECK: Record<string, { tone: "good" | "bad" | "warn"; label: string; title: string }> = {
  verified: { tone: "good", label: "Celo ✓", title: "Read back from Celo: the approved amount reached the approved address" },
  mismatch: { tone: "bad", label: "Celo mismatch", title: "Celo shows something different from what was approved — see Wallet → Records vs. Celo" },
  unverified: { tone: "warn", label: "Not checked", title: "This payment couldn't be read back from Celo — see Wallet → Records vs. Celo" },
};

/** The result of reading a payment back from Celo after it was sent. Nothing for payments not checked yet. */
export function ChainCheckBadge({ check }: { check: string | null }) {
  const c = check ? CHECK[check] : null;
  if (!c) return null;
  return (
    <span title={c.title}>
      <Badge tone={c.tone}>{c.label}</Badge>
    </span>
  );
}
