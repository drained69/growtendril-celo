import { Banknote, BadgeCheck, KeyRound } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { Eyebrow, Headline, Lede, Section } from "@/components/marketing/primitives";

const RAILS = [
  {
    icon: Banknote,
    title: "Pay creators in their own currency",
    body: "Approve a reward in dollars. The agent converts USD₮ on Textile FX and delivers naira, rupiah, reais or pesos to the creator's wallet.",
    detail: "cNGN · IDRX · wBRL · wARS · wMXN · wCOP",
  },
  {
    icon: KeyRound,
    title: "Limits the chain enforces",
    body: "Keep your wallet with an Altana passkey. The agent gets a key with a spend cap, approved contracts and an expiry, and one transaction revokes it.",
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
          <Eyebrow>On Celo</Eyebrow>
          <Headline>
            Growth budgets that reach
            <br />
            people where they live.
          </Headline>
          <Lede>Creators should get paid in money they can spend, and your agent should never hold your keys. GrowTendril is built for both on Celo mainnet, and checks each payment against the chain.</Lede>
        </Reveal>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
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
