import { CircleDollarSign } from "lucide-react";
import { cn } from "@/components/ui/cn";

/** One sentence that explains the money, used wherever USDC first appears. */
export const USDC_ONE_LINER = "USDC is a digital dollar: 1 USDC is worth $1.";

/**
 * "What is USDC, and how do I get some?" — the one explanation of money in GrowTendril.
 * Server-safe (no client hooks), so pages and marketing sections can both render it.
 */
export function UsdcHelp({ className, open, compact }: { className?: string; open?: boolean; compact?: boolean }) {
  return (
    <details open={open} className={cn("group rounded-[14px] border border-line bg-surface text-[13px] [&_summary::-webkit-details-marker]:hidden", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium text-ink">
        <CircleDollarSign className="size-4 shrink-0 text-accent" aria-hidden />
        <span className="flex-1">What is USDC, and how do I get some?</span>
        <span className="text-[11.5px] font-normal text-ink-3 group-open:hidden">Show</span>
        <span className="hidden text-[11.5px] font-normal text-ink-3 group-open:inline">Hide</span>
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-3.5 leading-relaxed text-ink-2">
        <p>
          <span className="font-medium text-ink">{USDC_ONE_LINER}</span> GrowTendril uses it on the Celo network, where sending money takes seconds and costs less than a cent.
        </p>
        {!compact && (
          <p>
            You use it in two places, and they are kept apart: <span className="font-medium text-ink">Credit</span> pays for scans and reports, and your <span className="font-medium text-ink">Payout account</span> holds the money that pays people, such as creators.
          </p>
        )}
        <div>
          <div className="font-medium text-ink">How to get USDC</div>
          <ul className="mt-1.5 space-y-1.5">
            <li className="flex gap-2"><span aria-hidden className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-4" /><span><span className="font-medium text-ink">MiniPay</span> — a phone wallet (in Opera Mini or its own app). Add money in the app and it is already USDC on Celo.</span></li>
            <li className="flex gap-2"><span aria-hidden className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-4" /><span><span className="font-medium text-ink">Valora</span> — a phone wallet for Celo where you can buy USDC.</span></li>
            <li className="flex gap-2"><span aria-hidden className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-4" /><span><span className="font-medium text-ink">An exchange</span> — buy USDC, then withdraw it and pick <span className="font-medium text-ink">Celo</span> as the network. Pick the wrong network and the money will not arrive.</span></li>
          </ul>
        </div>
        {!compact && <p className="text-[12px] text-ink-3">Paying from your own wallet also costs a tiny network fee. MiniPay can take it from your dollars; other wallets need a few cents of CELO.</p>}
      </div>
    </details>
  );
}
