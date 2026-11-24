# GrowTendril protocol on Celo mainnet

GrowTendril finds customers and creators, proposes small growth experiments, pays people only under the owner's rules, measures results, and moves budget toward what worked. AI, web research, email and login stay offchain. Money, limits, approvals and the record of decisions are enforced or committed onchain.

## Contracts

| Contract | Purpose |
|---|---|
| `GrowthFactory` | Creates one isolated `GrowthWorkspace` clone per customer. It has no owner and cannot touch funds. |
| `GrowthWorkspace` | Holds a customer's USDC and USD₮, roles, spend policy, missions, experiments, payment intents, payouts and kill switch. |
| `GrowthLedger` | Hash-chained Merkle checkpoints of receipts, evidence and learnings, plus cumulative experiment outcomes. |
| `OutcomeRewardsEscrow` | Prefunded creator campaign rewards with a review window, refund hold and arbiter. |

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
| Campaign owner (escrow) | Trusted only for their campaign | Fund, queue rewards, reduce pending outcome bonuses, dispute, reclaim unused funds | Take reserved rewards back without the arbiter |
| Arbiter (escrow) | Semi-trusted, chosen by campaign owner | Release or reject a disputed reward | Redirect funds. Silence for 14 days resolves for the recipient |
| Anyone | Untrusted | Relay escrow claims, cancel expired intents | Everything else |

## Key invariants

1. `reserved[token]` equals the sum of open intents in that token, and the owner cannot withdraw it.
2. A mission's committed spend never exceeds its budget, and an experiment's never exceeds its budget.
3. A payment to a person always needs a human approval from someone other than its proposer.
4. Whoever changed a payee cannot approve a payment to that payee for 24 hours.
5. An autonomous service payment stays within the per-transaction limit, daily limit, category budget and approved-service list.
6. A corridor payout spends at most the approved USD₮, delivers at least the approved minimum, leaves no allowance open, and is atomic.
7. Ledger outcome totals only rise, and a checkpoint cannot fork the hash chain.
8. In escrow, `available + reserved` always equals the token balance attributable to a campaign, and each reward is paid at most once.
9. A payment must still satisfy the current policy when it executes, so tightening limits also applies to intents already proposed.

## Operational implications

- Workspace balances are plain token balances, so a direct donation is withdrawable by that workspace's owner and creates no claim for anyone else.
- Spend accounting is committed at proposal and released on rejection or expiry, so budgets reflect open commitments rather than only settled spend.
- Daily spend is counted at execution, using UTC days.
- An operator compromise is bounded by each workspace's policy, and the owner stops it with the kill switch or by removing its role.
- x402 research is paid by the Self-verified agent key rather than the workspace, because Self identity and the x402 payer must match.

## Known limits

- A stolen operator key can write false outcome totals to the ledger for workspaces that granted it. Totals only rise, so correcting this means removing the operator and treating later records as untrusted. It cannot move funds.
- An escrow reward owed to an address that USDC has blacklisted stays locked until that address can receive again.
- The x402 research wallet holds its own balance outside workspace limits, so keep only a few USDC in it.
- The contracts have had an internal review and tests, but no independent audit.
