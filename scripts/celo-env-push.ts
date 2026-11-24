/**
 * Upload this deployment's non-empty, allowlisted .env values to the Celo Railway web service.
 *
 *   npm run celo:env:push -- --dry-run   list the variable names that would be uploaded
 *   npm run celo:env:push                upload them, then trigger one redeploy
 *
 * Values travel over stdin and are never printed. Private keys are deliberately excluded.
 */
import { spawnSync } from "node:child_process";

const PROJECT = "growtendril-celo";
const SERVICE = "web";
const ALLOWED = [
  "RESEND_API_KEY", "EMAIL_FROM", "OPERATOR_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL", "LLM_PROVIDER", "GITHUB_TOKEN", "X_BEARER_TOKEN",
  "YOUTUBE_API_KEY", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT", "RSS_FEEDS",
  "CELO_ATTRIBUTION_CODE", "CELO_AGENT_ID", "CELO_AGENT_PROJECT_ID", "CELO_REWARDS_ESCROW", "CELO_GROWTH_FACTORY", "CELO_GROWTH_LEDGER", "CELO_RESEARCH_URLS",
  "SELF_AGENT_ENABLED", "SIGNALS_PUBLIC_URL", "TEXTILE_API_KEY", "X402_API_KEY", "BILLING_CELO_ADDRESS",
];
const dryRun = process.argv.includes("--dry-run");
const status = spawnSync("railway", ["status", "--json"], {encoding: "utf8"});
let linked = "";
try { linked = (JSON.parse(status.stdout) as {name?: string}).name ?? ""; } catch { /* reported below */ }
if (linked !== PROJECT) throw new Error(`Refusing to upload: this folder must be linked to the ${PROJECT} Railway project.`);

const names = ALLOWED.filter((name) => process.env[name]?.trim());
console.log(`${dryRun ? "Would upload" : "Uploading"} ${names.length} variables to ${PROJECT}/${SERVICE}:\n${names.join("\n")}`);
if (dryRun || !names.length) process.exit(0);
for (const [index, name] of names.entries()) {
  const last = index === names.length - 1;
  const result = spawnSync("railway", ["variable", "set", name, "--stdin", "--service", SERVICE, ...(last ? [] : ["--skip-deploys"])], {input: process.env[name]!.trim(), encoding: "utf8"});
  if (result.status !== 0) throw new Error(`Railway did not accept ${name}. Nothing further was uploaded.`);
}
console.log("Uploaded. Railway is redeploying the web service.");
