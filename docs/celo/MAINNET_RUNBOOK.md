# Mainnet runbook

Follow these steps in order. Steps marked **Real money** send a transaction on Celo mainnet and cannot be undone. Run every command from the project root in your own terminal.

Submission closes **December 7, 2026 at 09:00 GMT**. Aim to finish step 11 by December 4, so there is time for a real user and for fixes.

## 1. Clear the two blockers

**Turn on signup first.** The live site has no email, Google or AI settings yet, so nobody can finish creating an account. This uploads them from your `.env`, and it never uploads a private key:

```bash
npm run celo:env:push
```

**Ask the organizers about eligibility.** The rules say code is written during the hackathon, from November 20, and GrowTendril existed before that. Tell them what was imported and what was built for Celo, and get their answer in writing. `docs/celo/import-manifest.json` lists the imported files.

**Contract review.** The contracts have had a manual review, invariant fuzzing and a partial automated audit, with every candidate finding checked and the valid ones fixed. [Validation](VALIDATION.md) has the details. The contracts cannot be upgraded after deployment, so any further change must happen before step 5, followed by a rerun of step 3.

## 2. Publish the repo and get your tag

1. Create the public GitHub repository. Check first that `.env` is not included.
2. Enroll the repository at [Loops](https://www.loops.house/agents-open-for-business).
3. Copy your issued attribution tag. You will use it as `CELO_ATTRIBUTION_CODE`.

## 3. Confirm the final code

```bash
npm run typecheck
```

```bash
npm test
```

```bash
cd contracts && forge test --no-match-contract Fork && cd ..
```

```bash
npm run celo:e2e
```

```bash
npm run celo:deploy -- --rehearse
```

All of them must pass. None of them sends a real transaction.

## 4. Create two new wallets

Use new wallets only. Do not reuse the GrowTendril `PRIVATE_KEY`, a Circle wallet or a personal wallet.

```bash
cast wallet new
```

```bash
cast wallet new
```

| Wallet | Variable | Lives in | Fund with |
|---|---|---|---|
| Deployer | `CELO_DEPLOYER_PRIVATE_KEY` | Local `.env` only | About 2.4 CELO |
| Agent (operator) | `CELO_AGENT_PRIVATE_KEY` | Local `.env` and Railway | 1 to 2 CELO for gas, plus a few USDC for x402 research |

Each agent transaction costs about 0.04 CELO, so 1 CELO covers roughly 25 of them. Add both keys and `CELO_ATTRIBUTION_CODE` to `.env` yourself. Never paste a private key into a chat. Back both keys up offline.

The **agent wallet** is the one Loops scores. Give Loops the agent address, never the deployer, and keep the same agent wallet for the whole event. If you join a Loops team, your tag changes: update `CELO_ATTRIBUTION_CODE` and push the settings again.

## 5. Deploy the contracts (Real money)

Check the current cost first:

```bash
npm run celo:deploy
```

It must say `"ready": true`. The last estimate was 7.67M gas, about 1.55 CELO, with 2.33 CELO recommended. Then deploy:

```bash
npm run celo:deploy -- --broadcast --confirm-mainnet
```

If it stops partway, run the same command again. It resumes from `contracts/deployments/celo-mainnet.json`.

After deploying, it publishes the contract source to Sourcify. To also show the source on Celoscan, put a free Etherscan API key in `.env` as `ETHERSCAN_API_KEY` before deploying. The output reports each contract as `verified` or `failed`. If any failed, retry without redeploying:

```bash
npm run celo:deploy -- --verify
```

Copy the three printed addresses into `.env`:

```
CELO_REWARDS_ESCROW=
CELO_GROWTH_FACTORY=
CELO_GROWTH_LEDGER=
```

## 6. Configure production

Preview, then upload the non-wallet settings:

```bash
npm run celo:env:push -- --dry-run
```

```bash
npm run celo:env:push
```

This script never uploads a private key. Add `CELO_AGENT_PRIVATE_KEY` yourself in Railway: project `growtendril-celo`, service `web`, Variables.

In Google Cloud, add this OAuth redirect URI:

```
https://celo.growtendril.xyz/api/auth/google/callback
```

Sign up at `https://celo.growtendril.xyz`, create your workspace, and copy its ID from the Wallet page. Set it as `CELO_AGENT_PROJECT_ID` in `.env`, then run `npm run celo:env:push` again.

## 7. Register the agent (Real money)

```bash
npm run celo:register
```

Review the preview, then submit:

```bash
npm run celo:register -- --submit
```

Set the printed ID as `CELO_AGENT_ID` and push the settings again. If a receipt is slow, look up the transaction hash. Do not register twice.

## 8. Verify with Self

Complete [Self Agent ID](https://docs.self.xyz/docs/agent-id/) for the **agent wallet**. A person must do the passport proof. Then set `SELF_AGENT_ENABLED=1`, push the settings, and check readiness:

```bash
railway run --service web npm run doctor -- --role=web,buyer
```

It exits with an error and names each missing item until everything required is in place.

## 9. Launch the paid research seller (optional for Self track)

Get `X402_API_KEY` from [x402.celo.org](https://x402.celo.org), and choose a `SIGNALS_SELLER_ADDRESS`. Deploy this repository as a second Railway service with start command `npm run signals`, and set `SIGNALS_PUBLIC_URL` and `CELO_RESEARCH_URLS` on `web`. `docs/celo/LAUNCH.md` has the details.

## 10. Open your workspace contract (Real money)

On the Wallet page:

1. Connect your **personal owner wallet**, not the agent wallet.
2. Create the workspace contract with the agent as operator.
3. Send a small amount of USDC to the workspace, such as 10 USDC.
4. Publish a mission.

## 11. Make the first real payment (Real money)

1. Start a real experiment for a real business, with a creator or customer **outside your team**.
2. When the payment appears in Approvals, read the amount and recipient in your wallet, then approve it.
3. Confirm the Wallet page shows it as settled, and open the transaction on Celoscan.
4. Run `verifyTx` from `@celo/attribution-tags` on the hash to confirm your tag counts.

For the Stablecoin Corridors track, make one Textile conversion to an outside recipient from your workspace contract. The owner approves it in their wallet, and the agent wallet converts and delivers in one tagged transaction. It needs two things first:

1. **A Textile partner API key.** Textile only quotes a contract wallet when the request carries a partner key. Ask Textile for one, set it as `TEXTILE_API_KEY`, and push the settings. Without it, the payment stops with "Add a Textile API key to convert from a smart wallet" and no funds move.
2. **USD₮ in the workspace contract.** Conversions sell USD₮, not USDC. Deposit a few USD₮ from the Wallet page.

Each workspace keeps the wallet it was first linked to, so do not attach the server wallet to the workspace you use for the contract. Altana relay attribution is unconfirmed, so do not rely on it for your counted transaction until Altana confirms it.

## 12. Submit

Include the public repo (`https://github.com/drained69/growtendril-celo`), the ERC-8004 ID, the agent wallet address, Self proof, attribution tag, mainnet transaction links, the outside user's consent and result, and a short video. Enter at most the tracks you actually demonstrated: **Stablecoin Corridors**, **Self Agent ID**, and **Altana Agent Wallets** if its flow works live. Do not claim Agent Vault.

## If something goes wrong

- **Stop all agent payments:** on the Wallet page, press **Freeze onchain**.
- **Agent key leaked:** press **Freeze onchain**, then **Remove agent**, then withdraw your USDC and USD₮. Do this before you change the key in Railway, because the button acts on the agent address the app currently uses. The leaked key cannot approve payments to people or withdraw.
- **Bad contract found after deployment:** there is no upgrade. Freeze, withdraw, fix, deploy new contracts, and point the app at the new addresses.
- **Payment shows an exception:** do not pay again. Check the wallet's history on Celoscan first, because the first payment may have landed.
