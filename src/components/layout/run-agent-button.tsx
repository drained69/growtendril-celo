"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Coins, Loader2, Play } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { AgentLog } from "@/components/features/agent/agent-log";
import { jobStatusAction, runCycleAction } from "@/server/actions/agent";
import { Dialog } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/misc";

/** Queues an operator cycle on the job worker and streams its log by polling the job. */
export function RunAgentButton({ disabled, priceUsdc, creditLow, ownsCredit }: { disabled?: boolean; priceUsdc?: number; creditLow?: boolean; ownsCredit?: boolean }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<{ agent: string; message: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const startingRef = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await jobStatusAction(jobId);
        if (stopped) return;
        if (!r.ok || !r.data) {
          setError(!r.ok ? r.error : "The worker did not return a job status.");
        } else {
          setError(null);
          setStatus(r.data.status);
          setLog(r.data.log);
          if (r.data.status === "done" || r.data.status === "failed") {
            if (r.data.skipped) {
              const message = r.data.skipped === "balance too low" ? "There isn't enough credit for a scan. Money in your Payout account is separate — add credit in Billing." : r.data.skipped;
              setError(message);
              setStatus("skipped");
              toast.error("Scan didn’t run", message, r.data.skipped === "balance too low" ? { label: ownsCredit ? "Add credit in Billing" : "Ask workspace owner", href: ownsCredit ? "/billing" : "/app/team" } : undefined);
            } else if (r.data.status === "done") toast.success("Scan finished", `${r.data.log.length} steps — open the log to see what it found`);
            else {
              setError(r.data.error ?? "The scan stopped before it finished. Try again in a minute.");
              toast.error("Scan didn't finish", r.data.error ?? "Try again in a minute.");
            }
            setJobId(null);
            router.refresh();
            return;
          }
        }
      } catch {
        if (!stopped) setError("We lost track of the scan for a moment. We'll keep checking.");
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobId, router, ownsCredit]);

  const running = !!jobId;
  if (creditLow && !running && !starting && !disabled) {
    return <LinkButton href={ownsCredit ? "/billing" : "/app/team"} variant="primary" icon={<Coins />}>{ownsCredit ? "Add credit to scan" : "Ask the owner for credit"}</LinkButton>;
  }
  return (
    <div className="relative">
      <Button
        variant="primary"
        size="sm"
        disabled={disabled}
        loading={starting}
        title={priceUsdc ? `Scan for customers now — ${priceUsdc} USDC from your credit (the GrowTendril fee)` : "Scan for customers now"}
        icon={running ? <Loader2 className="animate-spin" /> : <Play />}
        onClick={async () => {
          if (running) return setOpen(true);
          if (startingRef.current) return;
          startingRef.current = true;
          setStarting(true);
          try {
            const r = await runCycleAction();
            if (!r.ok) {
              if (r.code === "INSUFFICIENT_CREDIT") {
                router.refresh();
                return toast.error("Not enough credit for a scan", r.error, { label: r.nextHref === "/app/team" ? "Ask workspace owner" : "Add credit in Billing", href: r.nextHref ?? "/billing" });
              }
              return toast.error("Couldn’t start the scan", r.error);
            }
            if (!r.data?.jobId) return toast.error("Couldn’t start the scan", "Try again in a moment.");
            setError(null);
            setLog([]);
            setStatus("queued");
            setJobId(r.data.jobId);
            setOpen(true);
          } catch {
            toast.error("Couldn’t start the scan", "Check your connection and try again.");
          } finally {
            startingRef.current = false;
            setStarting(false);
          }
        }}
      >
        {running ? (status === "queued" ? "Starting…" : "Scanning…") : "Scan for customers"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Scan for customers${status ? ` · ${status === "queued" ? "starting" : status === "running" ? "scanning" : status}` : ""}`} description={running ? "You can close this and reopen it with the scanning button." : "What the scan did, step by step."} size="lg">
        {error && <Callout tone="danger" className="mb-3">{error}</Callout>}
        {log.length ? <AgentLog log={log} /> : <div role="status" className="rounded-[14px] border border-dashed border-line-strong bg-surface-2 px-3 py-5 text-center text-[12.5px] text-ink-3">{running ? "Waiting for the scan to report progress…" : "This scan didn't record any steps."}</div>}
        <Link href="/app/runs" onClick={() => setOpen(false)} className="mt-3 inline-block text-[12px] text-s1 hover:underline">See scan history</Link>
      </Dialog>
    </div>
  );
}
