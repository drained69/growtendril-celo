/** How a payment moved, as shown to people. Older rail keys map to neutral labels. */
export const RAIL_LABEL: Record<string, string> = {
  growth_vault: "Workspace contract",
  textile_corridor: "Local-currency payout · Textile FX",
  celo_x402: "Paid research · x402",
  celo_usdc_send: "Agent wallet transfer",
  app_kit_bridge: "Agent wallet transfer",
  gateway_deposit: "Agent wallet deposit",
};

/** What authorized the payment. */
export const RAIL_AUTH: Record<string, string> = {
  growth_vault: "Your wallet's approval, enforced by the contract",
  textile_corridor: "Converted and delivered in one transaction",
  celo_x402: "Signed USDC authorization",
  celo_usdc_send: "Agent wallet transaction",
  app_kit_bridge: "Agent wallet transaction",
  gateway_deposit: "Agent wallet transaction",
};
