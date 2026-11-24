# GrowTendril on Celo

GrowTendril is a growth agent for small businesses. It finds customers and creators, proposes small growth experiments, pays people only under the owner's rules, measures results, and moves budget toward what worked.

On Celo, the money and the rules live onchain. Each business gets its own workspace contract that holds its USDC and USD₮, its spending limits, its missions and experiments, and its kill switch. The GrowTendril agent can propose payments, but it cannot pay a person without the owner's approval, cannot exceed a limit, and cannot withdraw. AI, web research, email and login stay offchain.

Live app: [celo.growtendril.xyz](https://celo.growtendril.xyz)

## How it works

1. **Discover and plan.** The agent researches demand, scores customers and creators, and drafts an experiment inside a mission budget.
2. **Check policy onchain.** The workspace contract checks the proposed payment against the per-transaction limit, daily limit, category budget and mission budget, and reserves the funds.
3. **Approve.** A payment to a person needs a human approval, signed by the owner's own wallet. The agent's key cannot approve its own proposals.
4. **Pay.** Approved payments settle in USDC, or through Textile FX in the recipient's local stablecoin. A payment is marked settled only after Celo shows the exact transfer.
5. **Record and learn.** Outcomes and decision receipts are committed to a hash-chained ledger, and the agent shifts budget toward what worked.

The owner can freeze spending, remove the agent, or withdraw unreserved funds from the Wallet page at any time.

## Celo technology used

| Area | What GrowTendril uses it for |
|---|---|
| Workspace contracts | `GrowthFactory`, `GrowthWorkspace`, `GrowthLedger` and `OutcomeRewardsEscrow` in [`contracts/src`](contracts/src). Immutable, no admin key, no protocol fee. See [the protocol notes](docs/celo/PROTOCOL.md). |
| Stablecoins | Native USDC and USD₮ on Celo mainnet, chain 42220. |
| Textile FX | Converts approved USD₮ into cNGN, IDRX, wBRL, wARS, wMXN or wCOP so creators are paid in their own currency. |
| Altana | A passkey-owned, non-custodial wallet per workspace, with a capped, expiring session key for the agent. |
| Self Agent ID | Proves a verified human stands behind the agent, and gates the paid research service. |
| ERC-8004 | Agent registration, with metadata at `/.well-known/agent-registration.json`. |
| x402 v2 | The agent pays for research per request in USDC through Celo's facilitator. |
| ERC-8021 | Attribution tags on every agent transaction. |

Tracks targeted: **Stablecoin Corridors (Textile FX)**, **Self Agent ID** and **Altana Agent Wallets**. Agent Vault is not implemented.

## Status

The contracts and app are tested end to end on a private fork of Celo mainnet. They are not yet deployed on mainnet, and no real payment has been made. [Validation results](docs/celo/VALIDATION.md) lists what passed and what is not yet verified.

This repository builds on the earlier GrowTendril application, which predates the hackathon. [The implementation record](docs/celo/IMPLEMENTATION.md) and [import hashes](docs/celo/import-manifest.json) show what was imported and what was built for Celo.

## Run locally

Use Node 22.12 or later (22 LTS), Node 24, or Node 26.

```sh
npm ci
cp .env.example .env
npm run dev
```

Set `APP_URL=http://localhost:3000`. Without `DATABASE_URL`, a local PGlite database opens in `.data/`. Missing integrations stay off and never fabricate results.

Checks, none of which send a real transaction:

```sh
npm run typecheck
npm test
cd contracts && forge test --no-match-contract Fork && cd ..
npm run celo:e2e                 # app against real contracts on a private Celo fork (needs anvil)
npm run celo:deploy -- --rehearse
```

## Deploy

Follow [the mainnet runbook](docs/celo/MAINNET_RUNBOOK.md) in order. [The launch guide](docs/celo/LAUNCH.md) covers environment settings, Self registration and the optional paid research service.

## More

[Protocol notes](docs/celo/PROTOCOL.md) · [Validation](docs/celo/VALIDATION.md) · [Operator guide](docs/USER_GUIDE.md) · [Implementation record](docs/celo/IMPLEMENTATION.md) · [Original README](docs/celo/INHERITED_README.md)

The historical `arc:*` commands and Circle files are kept for reference only and are not used by the Celo app.
