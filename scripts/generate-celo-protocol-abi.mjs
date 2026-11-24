import { readFile, writeFile } from "node:fs/promises";

const target = "src/lib/celo-protocol-abi.ts";
const read = async (file, name) => JSON.parse(await readFile(`contracts/out/${file}/${name}.json`, "utf8")).abi;
const [workspace, factory, ledger] = await Promise.all([
  read("GrowthWorkspace.sol", "GrowthWorkspace"),
  read("GrowthFactory.sol", "GrowthFactory"),
  read("GrowthLedger.sol", "GrowthLedger"),
]);
await writeFile(target, [
  "// Generated from contracts/src/protocol by scripts/generate-celo-protocol-abi.mjs.",
  `export const GROWTH_WORKSPACE_ABI = ${JSON.stringify(workspace)} as const;`,
  `export const GROWTH_FACTORY_ABI = ${JSON.stringify(factory)} as const;`,
  `export const GROWTH_LEDGER_ABI = ${JSON.stringify(ledger)} as const;`,
  "",
].join("\n"));
console.log(`Updated ${target}`);
