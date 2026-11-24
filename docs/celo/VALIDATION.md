# Validation — November 24, 2026

## Not verified

- **The Plamen audit has not completed.** It needs the command-line Claude logged in to an account that can reach the API. The contracts have had a line-by-line manual review and the invariant fuzzing below. Run Plamen before deploying (see [the runbook](MAINNET_RUNBOOK.md)).
- **Nothing has happened on real Celo mainnet.** No contract deployment, wallet funding, ERC-8004 or Self registration, Textile swap, x402 payment, or outside-user payment has taken place.
- **The wallet buttons have not been clicked with a real browser wallet.** Their contract calls are tested on a fork, but the wallet popups are not.
- **The Altana passkey flow is untested live,** and Altana relay attribution is unconfirmed.
- **No Textile partner key yet.** Conversions from a workspace contract need one. Textile's free price preview works without it.
- **Hackathon eligibility needs an organizer ruling,** because the imported application predates the build period.
- Unit tests ran on Node 25.2.1. The production image runs Node 22.

## Passed

| Check | Result |
|---|---|
| TypeScript | Clean |
| App tests | 46 files, 418 tests passed |
| Contract tests | 44 passed, including 8 invariant tests |
| Invariant fuzzing, 8 safety rules (local run: 2,000 sequences of 256 random actions) | 512,000 actions per rule, no violation |
| Contract test against forked Celo USDC | Passed |
| App-to-contract test on a private Celo fork (`npm run celo:e2e`) | 22 of 22 checks passed |
| Deployment rehearsal on a private fork | Passed, including a real-USDC-contract creator payment |
| Mainnet deployment estimate | 7.62M gas, about 1.54 CELO, 2.32 CELO recommended |
| App contract interfaces against the compiled contracts | All four match |
| ERC-8004 registration, simulated on mainnet from the agent wallet | Succeeds, about 0.037 CELO |
| Textile FX live price preview | 5 USD₮ quoted into cNGN, wBRL and wCOP |
| Attribution tag encodes and decodes | Passed with the issued tag |
| Production dependency advisories | 0 |
| Production image on real PostgreSQL | Boots, migrates 62 tables, and serves all checked routes |
| Live site, `https://celo.growtendril.xyz` | Healthy, with security headers and no browser console errors on the landing or signup pages |

The fork test runs the real server code against the real contracts. It confirms that:

- A person cannot be paid without the owner's onchain approval, and the server key cannot bypass it.
- A payment is marked settled only after Celo shows the exact transfer.
- Rejection frees reserved funds, and the kill switch stops new payments.
- The owner can remove and restore the agent, and withdraw all unreserved funds.
- Outcomes and decision receipts are recorded onchain, and a forged record fails verification.

The invariant tests in `contracts/test/Invariants.t.sol` treat the agent's key as stolen and fire random sequences of every action by every party. After each step they check that:

- Reserved funds equal the open payments in each token.
- No mission or experiment exceeds its budget, and every commitment is counted exactly once.
- A payment to a person runs only with approval from someone other than the agent, and anything paid without approval went to an approved service.
- The agent never receives funds.
- A currency conversion never takes more USD₮ than approved, never delivers below the approved minimum, and leaves no allowance open.
- The owner can always withdraw everything not reserved, frozen or not.
- The escrow's balance equals what its campaigns hold, and each reward is paid at most once and for its exact amount.

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
