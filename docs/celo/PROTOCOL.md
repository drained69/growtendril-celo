# GrowTendril protocol on Celo mainnet

GrowTendril finds customers and creators, proposes small growth experiments, pays people only under the owner's rules, measures results, and moves budget toward what worked. AI, web research, email and login stay offchain. Money, limits, approvals and the record of decisions are enforced or committed onchain.

## Contracts

| Contract | Purpose |
|---|---|
| `GrowthFactory` | Creates one isolated `GrowthWorkspace` clone per customer. It has no owner and cannot touch funds. |
| `GrowthWorkspace` | Holds a customer's USDC and USD₮, roles, spend policy, missions, experiments, payment intents, payouts and kill switch. |
| `GrowthLedger` | Hash-chained Merkle checkpoints of receipts, evidence and learnings, plus cumulative experiment outcomes. |
| `OutcomeRewardsEscrow` | Prefunded creator campaign rewards with a review window, refund hold and arbiter. |
| `CampaignEscrow` | Prefunded open reward campaigns. The owner may name an agent that approves rewards within the fixed terms; each reward waits a 72-hour hold during which the owner can object. Deployed at `0xfbb1299540df7781a58563555c6429392de4859f`. |

The deployment is immutable. There is no proxy admin, upgrade path, pause key or protocol fee.

External dependencies on Celo mainnet (chain 42220):

- USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`, 6 decimals
- USD₮ `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, 6 decimals
- Textile FX LimitOrderReactor `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
- Payout tokens: cNGN, IDRX, wARS, wBRL, wMXN, wCOP

## Trust model

| Actor | Trust | Can | Must never be able to |
|---|---|---|---|
| Workspace owner | Fully trusted for their own workspace | Withdraw unreserved funds, change policy, manage roles, freeze, approve | Affect another workspace, or take funds already reserved for an open payment without rejecting it first |
| Admin | Semi-trusted, appointed by owner | Set policy, open missions, freeze and unfreeze, approve, execute | Withdraw, or manage other admins |
| Approver | Semi-trusted | Approve or reject payments, freeze | Change policy or unfreeze |
| Operator (GrowTendril's server agent) | **Untrusted for funds.** Assume its key can be stolen | Propose intents inside policy, open experiments within mission budget, register new payees, execute approved intents, write to the ledger for workspaces that granted it | Approve its own proposals, withdraw, change policy or roles, pay a person without human approval, exceed any cap, or spend more than an approved amount in a corridor swap |
| Payee or creator | Untrusted | Receive payments, dispute their escrow reward | Change amounts or redirect others' funds |
| Campaign owner (escrow) | Trusted only for their campaign | Fund, queue rewards, reduce pending outcome bonuses while the recipient still has a day to dispute, dispute, reclaim unused funds | Take reserved rewards back without the arbiter, or cut a reward after a dispute |
| Arbiter (escrow) | Semi-trusted, chosen by campaign owner | Release or reject a disputed reward | Redirect funds. Silence for 14 days resolves for the recipient |
| Open campaign owner (CampaignEscrow) | Trusted only for their campaign | Fund, approve rewards, object to a waiting reward before its hold ends, replace or remove the agent, reclaim unused money after the review window | Take back a reward once its hold has passed, change the terms, or touch another campaign |
| Open campaign agent (GrowTendril's operator) | **Untrusted for funds.** Assume its key can be stolen | Approve rewards at the fixed amount for campaigns that currently name it, relay payouts | Approve the owner, itself or anyone the owner objected to; exceed the spots or the terms; skip the hold; approve after being removed |
| Open campaign participant | Untrusted | Sign the terms, receive one reward per campaign, relay their own payout | Receive twice in a campaign, or change the amount or recipient |
| Anyone | Untrusted | Relay escrow claims, cancel expired intents | Everything else |

## Key invariants

1. `reserved[token]` equals the sum of open intents in that token, and the owner cannot withdraw it.
2. A mission's committed spend never exceeds its budget, and an experiment's never exceeds its budget.
3. A payment to a person, and every currency conversion, always needs a human approval from someone other than its proposer.
4. Whoever changed a payee cannot approve a payment to that payee for 24 hours.
5. An autonomous service payment stays within the per-transaction limit, daily limit, category budget and approved-service list.
6. A corridor payout spends at most the approved USD₮, delivers at least the approved minimum, leaves no allowance open, and is atomic.
7. Ledger outcome totals only rise, and a checkpoint cannot fork the hash chain.
8. In escrow, `available + reserved` always equals the token balance attributable to a campaign, and each reward is paid at most once.
9. A payment must still satisfy the current policy when it executes, so tightening limits also applies to intents already proposed.
10. In CampaignEscrow, the token balance equals the sum of every campaign's `available + reserved`; each campaign's `reserved` equals its waiting rewards, its count equals waiting plus paid rewards, and its count never exceeds its spots.
11. In CampaignEscrow, only the owner or the currently named agent approves a reward, never above the terms and never to an objected recipient; a recipient holds at most one waiting or paid reward per campaign; an objected reward is never paid; objection happens only before the hold ends and payout only after.

## Operational implications

- Workspace balances are plain token balances, so a direct donation is withdrawable by that workspace's owner and creates no claim for anyone else.
- Spend accounting is committed at proposal and released on rejection or expiry, so budgets reflect open commitments rather than only settled spend.
- Daily spend is counted at execution, using UTC days.
- An operator compromise is bounded by each workspace's policy, and the owner stops it with the kill switch or by removing its role.
- In open campaigns, a stolen operator key reaches at most the unspent money of live campaigns that still name it, and only through rewards that wait 72 hours. The owner recovers all of it by objecting to those rewards and calling `setAgent` with the zero address. The key never reaches a workspace contract or the owner's wallet.
- Open campaign terms people sign are plain text; their keccak-256 hash is stored in the campaign, so the terms can't change after funding.
- x402 research is paid by the Self-verified agent key rather than the workspace, because Self identity and the x402 payer must match.

## Known limits

- A stolen operator key can write false outcome totals to the ledger for workspaces that granted it. Totals only rise, so correcting this means removing the operator and treating later records as untrusted. It cannot move funds.
- An escrow reward owed to an address that USDC has blacklisted stays locked until that address can receive again.
- The x402 research wallet holds its own balance outside workspace limits, so keep only a few USDC in it.
- A stolen operator key can clutter a workspace with junk proposals or experiments, and race the owner's ledger checkpoints. It cannot move funds. The owner clears proposals with one rejection, stops experiments, and removes the agent.
- Funds held by an expired payment stay reserved until anyone cancels it or the owner rejects it.
- A conversion's minimum payout is fixed when it is proposed. The app refuses to let the owner approve one that is below 85% of Textile's live rate, but approving directly on the contract skips that check.
- An open campaign's owner must act on an unwanted reward within its 72-hour hold to object. The app checks Celo every 5 minutes and emails the owner when a campaign holds more rewards than the app approved, but it relies on the owner reading that email in time.
- An open campaign's money can be reclaimed only 7 days after its deadline, even if the owner stops it early, so the last approved claims can finish.
- The app caps open campaigns at 50 USDC per person and 500 USDC per campaign while the contract is unaudited. The contract itself doesn't enforce those caps.
- The contracts have had an internal review, invariant fuzzing and a partial automated audit, but no independent human audit.
