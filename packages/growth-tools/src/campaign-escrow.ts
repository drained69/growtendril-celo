import { CAMPAIGN_ESCROW_RUNTIME, CAMPAIGN_ESCROW_IMMUTABLE_RANGES } from "./campaign-escrow-artifact.js";
import { matchesRuntime } from "./code-match.js";
export { CAMPAIGN_ESCROW_ABI } from "./campaign-escrow-artifact.js";
/** True only for the reviewed CampaignEscrow runtime, whatever token and hold it was deployed with. */
export function isCampaignEscrowCode(code: string) {
  return matchesRuntime(code, CAMPAIGN_ESCROW_RUNTIME, CAMPAIGN_ESCROW_IMMUTABLE_RANGES);
}
