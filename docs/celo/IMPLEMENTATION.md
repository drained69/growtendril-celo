# Implementation record

Imported on November 22, 2026 from the GrowTendril (`growthos`) repository. `import-manifest.json` records the source commit and hashes of copied files before migration. The source repository was not changed. Excluded: `.git`, `node_modules`, `.next*`, `.data`, production `.env`/`.env.local`, `.railway`, local agent settings and generated TypeScript state. Original video materials are present locally and remain Git-ignored.

The Celo integration keeps the original growth domain, permissions, approval/ledger state machines, customer-value calculations, notifications, public-source readers, team management, billing, campaigns and reusable contract/toolkit source. Active payment imports route through `src/server/integrations/celo`. Inherited Circle code and Arc deployments remain historical references, never default Celo deployments.

Celo receipts read only logs from the verified USDC contract. A native CELO transfer or another token's matching Transfer event cannot credit a USDC invoice. x402 settlements return real transaction hashes, which are checked against the approved payer, recipient and amount before settlement. Failed or pending receipts remain unresolved. The dedicated server signer requires the assigned tag, Celo chain ID and workspace binding; transaction submissions use a shared in-process viem nonce manager.

The Self Signals gate recovers request identity using the official SDK and requires the payment payer to match that identity. It runs before the x402 middleware; a caller cannot pay around a failed identity check. Enrichment purchases sign their exact quoted amount only after the inherited policy checks. The configurable research catalog replaces Circle Discovery. New provider output requires a compatible normalized signal schema.

The creator reward escrow is deployed to Celo mainnet together with the workspace contracts by `npm run celo:deploy`, and the app uses it only when `CELO_REWARDS_ESCROW` is set. The previous Arc address is never selected automatically.

The core growth loop is enforced onchain by `GrowthFactory`, `GrowthWorkspace` and `GrowthLedger`. Each workspace contract holds the business's funds, spending rules, missions, experiments, payment intents and kill switch, and the ledger commits outcomes and decision receipts. See [PROTOCOL.md](PROTOCOL.md).

Textile FX payouts validate the settlement contract, taker, chain, amount and expiry before signing, approve only the quoted amount, and settle from Celo logs. A conversion that is not followed by a confirmed delivery becomes a ledger exception and is never sent twice automatically. The payout currency is fixed when a payment is proposed.

Altana wallets are owned by the customer's passkey. The server generates the agent's session key, sends only its public key to the browser, stores the private key encrypted, and activates or revokes it only after reading the wallet contract. Research still uses the Self-verified server key because Self identity and the x402 payer must match.

Deployment limitations: no live Celo payments or identities have been provisioned, and no independent user outcome has been collected. Run one direct-signing web/worker process per server key and one Signals process until shared nonce/replay coordination is implemented. Agent Vault is not implemented.

The inherited Next.js version had a critical advisory and was upgraded from 15.5.27 to 15.5.29. On November 24, 2026, production dependency advisories were reduced to 0. The retired Circle SDKs are development dependencies only and are pruned from the production image.
