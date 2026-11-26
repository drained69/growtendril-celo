# Escrow source licensing and deployed-source identity

The copyright holder of GrowTendril's `OutcomeRewardsEscrow.sol` source and its Foundry test grants permission to use, modify and redistribute the copies distributed with GrowTendril Growth Tools under the [Apache License, Version 2.0](LICENSE).

The first line of those two Solidity files still reads `SPDX-License-Identifier: UNLICENSED`. That header is retained **only to keep the mainnet deployment's exact published source bytes and source hash reproducible**. For these copies, the explicit Apache-2.0 grant above is the current permission statement. The Celo mainnet deployment record preserves the source SHA-256, and [Sourcify holds the exact-match record](https://repo.sourcify.dev/42220/0x3157ed9d980dd30f419419145c1fcb481789fe15).

Changing the SPDX header and recompiling would change Solidity metadata and no longer reproduce the deployed bytecode exactly. This grant does not change the deployed contract or imply that it has received an independent security audit.
