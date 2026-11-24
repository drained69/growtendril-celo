# Mainnet runbook

Follow these steps in order. Steps marked **Real money** send a transaction on Celo mainnet and cannot be undone. Run every command from the project root in your own terminal.

Submission closes **December 7, 2026 at 09:00 GMT**. Aim to finish step 11 by December 4, so there is time for a real user and for fixes.

## 1. Clear the two blockers

**Turn on signup first.** The live site has no email, Google or AI settings yet, so nobody can finish creating an account. This uploads them from your `.env`, and it never uploads a private key:

```bash
npm run celo:env:push
```

**Ask the organizers about eligibility.** The rules say code is written during the hackathon, from November 20, and GrowTendril existed before that. Tell them what was imported and what was built for Celo, and get their answer in writing. `docs/celo/import-manifest.json` lists the imported files.

**Run the independent contract audit.** It cannot start inside a Claude session, so open the macOS Terminal app, go to the project folder, and run:

```bash
python3 ~/.claude/scripts/plamen_driver.py --fresh "$PWD/contracts/.scratchpad/config.json"
```

Fix every Critical, High and valid Medium finding, then rerun step 3. The contracts cannot be upgraded after deployment, so this is the last cheap moment to change them.

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
| Agent (operator) | `CELO_AGENT_PRIVATE_KEY` | Local `.env` and Railway | About 1 CELO, plus a few USDC for x402 research |

Add both keys and `CELO_ATTRIBUTION_CODE` to `.env` yourself. Never paste a private key into a chat. Back both keys up offline.

## 5. Deploy the contracts (Real money)

Check the current cost first:

```bash
npm run celo:deploy
```

It must say `"ready": true`. The last estimate was 7.62M gas, about 1.54 CELO, with 2.32 CELO recommended. Then deploy:

```bash
npm run celo:deploy -- --broadcast --confirm-mainnet
```

If it stops partway, run the same command again. It resumes from `contracts/deployments/celo-mainnet.json`. Copy the three printed addresses into `.env`:

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

For the Stablecoin Corridors track, make one Textile conversion from the **tagged server wallet** to an outside recipient. Altana relay attribution is unconfirmed, so do not rely on it for your counted transaction until Altana confirms it.

## 12. Submit

Include the public repo, the ERC-8004 ID, agent wallet, Self proof, attribution tag, mainnet transaction links, the outside user's consent and result, and a short video. Enter at most the tracks you actually demonstrated: **Stablecoin Corridors**, **Self Agent ID**, and **Altana Agent Wallets** if its flow works live. Do not claim Agent Vault.

## If something goes wrong

- **Stop all agent payments:** on the Wallet page, press **Freeze onchain**.
- **Agent key leaked:** press **Freeze onchain**, then **Remove agent**, then withdraw your USDC and USD₮. Do this before you change the key in Railway, because the button acts on the agent address the app currently uses. The leaked key cannot approve payments to people or withdraw.
- **Bad contract found after deployment:** there is no upgrade. Freeze, withdraw, fix, deploy new contracts, and point the app at the new addresses.
- **Payment shows an exception:** do not pay again. Check the wallet's history on Celoscan first, because the first payment may have landed.
