import { ESCROW_RUNTIME, ESCROW_IMMUTABLE_RANGES } from "./escrow-artifact.js";
import { matchesRuntime } from "./code-match.js";
export { OUTCOME_ESCROW_ABI } from "./escrow-artifact.js";
/** Check the compiled runtime while ignoring only Solidity's declared immutable slots. */
export function isOutcomeEscrowCode(code: string) {
  return matchesRuntime(code, ESCROW_RUNTIME, ESCROW_IMMUTABLE_RANGES);
}
