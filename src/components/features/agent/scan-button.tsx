import { Radar } from "lucide-react";
import { runCycleAction } from "@/server/actions/agent";
import { ActionButton } from "@/components/features/agent/action-button";
import { LinkButton } from "@/components/ui";

/**
 * "Scan for customers" — always starts a scan (or says why it can't, e.g. no credit).
 * People who can't run scans get a link to the scan history instead of a button that does nothing.
 */
export function ScanButton({ canRun, label = "Scan for customers", variant = "primary" }: { canRun: boolean; label?: string; variant?: "primary" | "secondary" }) {
  if (!canRun) return <LinkButton href="/app/runs" variant="ghost" icon={<Radar />}>See scan history</LinkButton>;
  return <ActionButton action={runCycleAction} label={label} icon={<Radar />} variant={variant} logTitle="Scan for customers" />;
}
