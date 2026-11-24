# Validation — November 24, 2026

## Not verified

- **No independent contract audit has run.** Plamen cannot start inside a Claude session, so the contracts have had a manual security review only. Run it from a normal terminal before deploying (see [the runbook](MAINNET_RUNBOOK.md)).
- **Nothing has happened on real Celo mainnet.** No contract deployment, wallet funding, ERC-8004 or Self registration, Textile swap, x402 payment, or outside-user payment has taken place.
- **The wallet buttons have not been clicked with a real browser wallet.** Their contract calls are tested on a fork, but the wallet popups are not.
- **The Altana passkey flow is untested live,** and Altana relay attribution is unconfirmed.
- **Hackathon eligibility needs an organizer ruling,** because the imported application predates the build period.
- Unit tests ran on Node 25.2.1. The production image runs Node 22.

## Passed

| Check | Result |
|---|---|
| TypeScript | Clean |
| App tests | 46 files, 418 tests passed |
| Contract tests | 36 passed |
| Contract test against forked Celo USDC | Passed |
| App-to-contract test on a private Celo fork (`npm run celo:e2e`) | 22 of 22 checks passed |
| Deployment rehearsal on a private fork | Passed, including a real-USDC-contract creator payment |
| Mainnet deployment estimate | 7.62M gas, about 1.54 CELO, 2.32 CELO recommended |
| Production dependency advisories | 0 |
| Production image on real PostgreSQL | Boots, migrates 62 tables, and serves all checked routes |
| Live site, `https://celo.growtendril.xyz` | Healthy, with security headers and no browser console errors on the landing or signup pages |

The fork test runs the real server code against the real contracts. It confirms that:

- A person cannot be paid without the owner's onchain approval, and the server key cannot bypass it.
- A payment is marked settled only after Celo shows the exact transfer.
- Rejection frees reserved funds, and the kill switch stops new payments.
- The owner can remove and restore the agent, and withdraw all unreserved funds.
- Outcomes and decision receipts are recorded onchain, and a forged record fails verification.

## Fixed in this audit

**Contracts**

- Payments now recheck the current spending rules at execution.
- A stopped experiment returns its unspent budget to the mission.
- Only an admin can stop an experiment.
- An operator cannot overwrite an existing payee.
- Ledger leaves are domain-separated, so an internal Merkle node cannot pass as a record.
- Escrow campaigns are bound to their owner, each reward can be disputed once, and a silent arbiter resolves for the recipient after 14 days.

**Application**

- Approval now checks the recipient and amount onchain, and the wallet shows those terms before signing.
- Rejecting a payment also closes it onchain.
- Linking a workspace and saving an Altana wallet are restricted to the right roles.
- The owner can now withdraw USD₮ and remove a compromised agent from the Wallet page.
- Production advisories fell from 52 to 0. The retired Circle SDKs no longer ship in the running image.
- The site now sends a content security policy and HSTS.

## Known limits

See [Known limits in the protocol notes](PROTOCOL.md#known-limits).
