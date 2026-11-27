# Celo launch and submission

For the ordered launch steps, use [the mainnet runbook](MAINNET_RUNBOOK.md). This page holds the background for each integration. This is not yet a completed mainnet entry. Source: [event rules](https://www.loops.house/agents-open-for-business). Submission closes December 7, 2026 at 09:00 GMT. Every entry needs ERC-8004 registration, a public GitHub repo, and its issued attribution tag on counted direct transactions. Register your x402 PayTo address too; the event currently accounts for x402 through PayTo rather than calldata tags.

Disclose that this imports an existing GrowTendril application and ask the organizers whether the new Celo work qualifies under their build-period rule. Keep the import manifest and original README available to reviewers.

## Hosting and domain

1. Create a separate hosting project/service for this Celo fork and a **new** PostgreSQL database. Do not point it at GrowTendril's existing production database, deployment or wallet. Use Node 22 LTS; a `Dockerfile` is included.
2. Configure the production variables from `.env.example`. Set `APP_URL=https://celo.growtendril.xyz`, `DATABASE_URL`, a unique random `SESSION_SECRET` of at least 32 characters, and a random 32-byte `ENCRYPTION_KEY`. Add email, Google OAuth and source/AI credentials as needed. Google redirect: `https://celo.growtendril.xyz/api/auth/google/callback`.
3. Add `celo.growtendril.xyz` as the hosting service's custom domain and apply the DNS records **that provider returns**. Wait for managed HTTPS. DNS values depend on your deployment and are not invented here.
4. Build with `npm ci && npm run build`; start with `npm start`. Migrations run on first database access. `/api/health` checks database availability and reports configured integrations. A healthy database does not certify wallet funding, ERC-8004 or Self registration.
5. Keep the default in-process worker for this initial single-instance deployment. Run one process capable of direct signing per agent key; viem coordinates nonces inside that process. Scaling signing to multiple processes needs shared nonce coordination or a dedicated signer service.
6. Open signup, verify email, create a workspace and find its ID on Wallet. Then configure the dedicated signer below and restart.

## Dedicated wallet and attribution

Use a new dedicated EVM wallet. Store its private key only in the server's secret configuration as `CELO_AGENT_PRIVATE_KEY`. Set `CELO_AGENT_PROJECT_ID` to the workspace ID. This explicit binding prevents other workspaces attaching the deployment's wallet. Existing policy rules still gate spend; this EOA does not provide Altana's onchain session-key controls.

Enroll your public repository in Loops, copy the **issued** tag into `CELO_ATTRIBUTION_CODE`, add your wallet to the entry, then fund it with small amounts of Celo mainnet USDC and CELO. The application refuses to sign without the tag. Attach the configured wallet from the workspace's Wallet page.

`BILLING_CELO_ADDRESS` is your separate optional recipient for customer scan-credit invoices. Scan credit, the workspace operating wallet and the Signals seller wallet have different purposes. Never import a production Circle wallet or use a Circle API key here.

## ERC-8004 identity

The metadata endpoint is public at `https://celo.growtendril.xyz/.well-known/agent-registration.json`.

```sh
npm run celo:register
# Review the preview, publish metadata, configure the correct wallet and tag, then:
npm run celo:register -- --submit
```

The second command submits a real tagged Celo transaction and spends CELO gas. It checks for an existing identity first. Set `CELO_AGENT_ID` to the ID printed after confirmation, restart, and add it to your Loops entry. Do not run a registration again merely because a receipt is delayed: inspect the submitted hash first.

Reference: [Celo ERC-8004 guide](https://docs.celo.org/build-on-celo/build-with-ai/8004), [attribution SDK](https://github.com/celo-org/attribution-tags/blob/main/BUILDERS.md).

## Self identity

Complete [Self Agent ID registration](https://docs.self.xyz/docs/agent-id/overview/) for the **same agent address** used to pay research services, on mainnet. A human must complete the passport proof. An ERC-8004 ID by itself is not Self proof. Do not replace the configured agent key with a newly generated key unless it is the wallet intended for this workspace and identity.

After verification, set `SELF_AGENT_ENABLED=1` and run `npm run doctor -- --role=web,buyer` on the web service and `npm run doctor -- --role=seller` on Signals. The command is read-only and exits nonzero until every required check passes, including funding, onchain ERC-8004 ownership and URI, and the Self proof. Self's request signature covers method, path, query and raw body. The service uses SDK signature verification, current human-proof checks, replay protection and per-agent rate limiting; it never trusts a caller-provided wallet address alone.

## Paid research service

The included Signals service preserves the company-enrichment and narrative research endpoints. It requires valid Self identity **before** it presents a payment challenge. Unauthenticated agents receive 401; invalid payer/identity bindings receive 403; missing service configuration receives 503. SDK/facilitator failure does not expose paid content.

1. Obtain a seller API key through the [Celo x402 dashboard](https://x402.celo.org) and set `X402_API_KEY`; set `SIGNALS_SELLER_ADDRESS` to the Celo USDC recipient. Register that PayTo address in Loops.
2. Deploy the same repository as a separate service with start command `npm run signals`, set its healthcheck path to `/`, expose port `SIGNALS_API_PORT` (default 4021), and provide a public HTTPS URL. If your host assigns `PORT`, the service also accepts it. Give the seller only the credentials it needs; it does not require the buyer's private key.
3. Set `SIGNALS_PUBLIC_URL` in the web service to that HTTPS origin. Set `CELO_RESEARCH_URLS` to approved company-intel URLs, such as `https://YOUR-SIGNALS-HOST/v1/company-intel`. The catalog reads live 402 terms; it does not invent prices or assume Circle batching works on Celo.
4. In GrowTendril, use a real named business, mission and prospect. Discovery refreshes the configured catalog. Buying research goes through the existing information-value check, spend policy, approval where required, signed x402 purchase and recorded evidence. Refresh settlements to verify the USDC transfer before marking it settled.
5. Demonstrate unauthenticated rejection, an authenticated challenge, one paid authorized request, and the resulting source evidence/receipt. Repeat with a second independent registered agent/user when available. Calls between wallets you control are integration checks, not independent traction.

Company research is 0.0025 USDC per request; narrative research is 0.00125 USDC. The creator-demographics endpoint explicitly returns unavailable, without a paywall, because no permitted public source exists. These are small live purchases, not fixtures. If sources fail and no evidence is available, the service returns 503 and x402 does not settle. Partial results are marked `complete: false`. If a signed payment's outcome cannot be confirmed, the ledger records an exception and keeps the amount committed until someone checks the wallet's Celo history.

Replay/rate caches in the Self SDK are process-local. Use one seller process for this initial deployment; multi-instance deployment requires shared replay/rate state.

## Optional buy services

[buy](https://usebuy.ai/docs) is optional for this track. The current app can buy compatible Celo USDC x402 research endpoints once configured, but does not automatically treat arbitrary buy output as GrowTendril enrichment evidence. To browse buy separately, the official CLI provides `buy skills search <query>` and `buy quote <URL>`; the latter previews without paying. Keep any integration through the existing policy ledger, and add a response-normalization adapter before using a new provider's data. No buy purchases have been made by this migration.

## Submission evidence

Record the real business/user's consent and job, the agent wallet/ID, Self verification, seller PayTo, issued tag, mainnet transaction links, paid-service receipt and the resulting growth decision. Verify that direct transactions include your exact assigned code. Add a short walkthrough video showing that work. Publicize only reviewed source and artifacts; `.env`, key files, database contents and local video output stay ignored by Git.

The target tracks are **Stablecoin Corridors**, **Altana Agent Wallets** and **Self Agent ID**. A project can win in up to two tracks. Do not claim Agent Vault: it is not implemented. Do not claim the others until their required mainnet demonstrations exist.

## Textile FX corridor

Fund the paying wallet with USD₮ and set a creator's payout address and currency on their profile. Approving a payment locks that currency. The track needs at least one tagged conversion in the product flow, with the local stablecoin reaching a recipient outside the team. Arbitrage and self-trading do not count.

A server wallet can quote without a key. An Altana wallet needs `TEXTILE_API_KEY` from the [Textile app](https://app.textilecredit.com/). With that key, Textile adds your attribution code to the swap.

## Altana wallet

On Wallet, create the passkey wallet, fund it with CELO, USDC and USD₮, then grant a limited agent key. For the demo, show the cap and allowlist, a successful payout, the revoke transaction, and the agent being refused afterward. Altana credits XP to the wallet address, so include it in the submission.

**Check attribution before relying on this path.** Altana's relay has no hook for a transaction-level suffix, so GrowTendril tags each inner call. After the first Altana transaction, run `verifyTx` from `@celo/attribution-tags` on its hash and ask Altana how relay transactions are credited. Until that is confirmed, make the counted Textile conversion from the tagged server wallet.
