import { readFile, writeFile } from "node:fs/promises";

/** Writes each escrow's ABI and deployed runtime, with its immutable byte ranges, for code checks in the app. */
const contracts = [
  { name: "OutcomeRewardsEscrow", target: "packages/growth-tools/src/escrow-artifact.ts", abi: "OUTCOME_ESCROW_ABI", runtime: "ESCROW_RUNTIME", ranges: "ESCROW_IMMUTABLE_RANGES" },
  { name: "CampaignEscrow", target: "packages/growth-tools/src/campaign-escrow-artifact.ts", abi: "CAMPAIGN_ESCROW_ABI", runtime: "CAMPAIGN_ESCROW_RUNTIME", ranges: "CAMPAIGN_ESCROW_IMMUTABLE_RANGES" },
];
for (const c of contracts) {
  const artifact = JSON.parse(await readFile(`contracts/out/${c.name}.sol/${c.name}.json`, "utf8"));
  const ranges = Object.values(artifact.deployedBytecode.immutableReferences).flat();
  const body = [
    `// Generated from contracts/src/${c.name}.sol with Solc 0.8.30, optimizer 200, Cancun.`,
    `export const ${c.abi} = ${JSON.stringify(artifact.abi)} as const;`,
    `export const ${c.runtime} = ${JSON.stringify(artifact.deployedBytecode.object)};`,
    `export const ${c.ranges} = ${JSON.stringify(ranges)};`,
    "",
  ].join("\n");
  await writeFile(c.target, body);
  console.log(`Updated ${c.target}`);
}
