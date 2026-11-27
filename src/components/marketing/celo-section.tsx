import { Banknote, BadgeCheck, KeyRound, Landmark } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { Eyebrow, Headline, Lede, Section } from "@/components/marketing/primitives";

const RAILS = [
  {
    icon: Landmark,
    title: "A contract you own",
    body: "Your Payout account is your own workspace contract on Celo. Your limits are built into it. GrowTendril's agent can propose payments, but only your wallet approves a payment to a person, and you can pause it or take money out at any time.",
    detail: "Owner-controlled · enforced onchain",
  },
  {
    icon: Banknote,
    title: "Pay creators in their own currency",
    body: "Approve a reward in dollars. The agent converts USD₮ on Textile FX and delivers naira, rupiah, reais or pesos to the creator's wallet.",
    detail: "cNGN · IDRX · wBRL · wARS · wMXN · wCOP",
  },
  {
    icon: KeyRound,
    title: "Or keep custody with a passkey",
    body: "Prefer a wallet? Keep funds in an Altana passkey wallet. The agent gets a key with a spend cap, approved contracts and an expiry, and one transaction revokes it.",
    detail: "Non-custodial · revocable onchain",
  },
  {
    icon: BadgeCheck,
    title: "Research from verified agents",
    body: "Paid research is served only to agents with a Self Agent ID. Limits follow the person behind them, and each request settles over x402.",
    detail: "Self Agent ID · x402 · ERC-8004",
  },
];

export function OnCelo() {
  return (
    <Section id="celo">
      <div className="mx-auto max-w-[1180px] px-5 sm:px-8">
        <Reveal>
          <Eyebrow>Technical details</Eyebrow>
          <Headline>
            For the curious:
            <br />
            how it works underneath.
          </Headline>
          <Lede>You don&apos;t need any of this to use GrowTendril. Payments run on Celo, a payments network where digital dollars move in seconds for less than a cent. Your Payout account is a contract on Celo that only your wallet controls, and every payment is checked against the public record.</Lede>
        </Reveal>
        <div className="mt-12 grid gap-5 md:grid-cols-2">
          {RAILS.map(({ icon: Icon, title, body, detail }, i) => (
            <Reveal key={title} delay={i * 80} className="window flex flex-col p-6">
              <Icon className="size-5 text-accent" aria-hidden />
              <h3 className="mt-5 text-[18px] font-semibold leading-snug text-ink">{title}</h3>
              <p className="mt-3 flex-1 text-[15px] leading-relaxed text-ink/60">{body}</p>
              <p className="mt-5 font-mono text-[11.5px] text-ink-3">{detail}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
