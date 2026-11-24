"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { useHydrated } from "@/components/ui/submit";
import { previewPayoutAction, setKolPayoutTokenAction } from "@/server/actions/celo-rails";

const OPTIONS = [["", "USDC"], ["cNGN", "cNGN · Nigerian naira"], ["IDRX", "IDRX · Indonesian rupiah"], ["wBRL", "wBRL · Brazilian real"], ["wARS", "wARS · Argentine peso"], ["wMXN", "wMXN · Mexican peso"], ["wCOP", "wCOP · Colombian peso"]] as const;

/** Where the creator wants to be paid in their own currency. Later approvals show and lock this choice. */
export function PayoutCurrency({ kolId, current, disabled }: { kolId: string; current: string | null; disabled?: boolean }) {
  const [value, setValue] = useState(current ?? "");
  const [quote, setQuote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const hydrated = useHydrated();
  const change = (token: string) => {
    const previous = value;
    setValue(token);
    setQuote(null);
    start(async () => {
      const saved = await setKolPayoutTokenAction(kolId, token);
      if (!saved.ok) {
        setValue(previous);
        toast.error("Couldn’t save payout currency", saved.error);
        return;
      }
      toast.success(saved.message ?? "Saved");
      router.refresh();
      if (token) {
        const preview = await previewPayoutAction(token, "10");
        setQuote(preview.ok && preview.data ? `10 USD₮ is about ${preview.data.receives} right now.` : "No live Textile FX price right now.");
      }
    });
  };
  return <Field label="Paid in" htmlFor={`payout-token-${kolId}`} hint={quote ?? (value ? "Converted on Textile FX when a payment runs. Your wallet needs USD₮." : "Paid directly in USDC.")}>
    <Select id={`payout-token-${kolId}`} value={value} disabled={!hydrated || disabled || pending} onChange={(e) => change(e.target.value)}>
      {OPTIONS.map(([token, label]) => <option key={token} value={token}>{label}</option>)}
    </Select>
  </Field>;
}
