import { formatUnits, type Address } from "viem";

/** Celo mainnet addresses from the event's Textile FX brief. Decimals were read from each contract. */
export const USDT = {symbol: "USD₮", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address, decimals: 6} as const;
export const TEXTILE_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address;

export const PAYOUT_TOKENS = {
  cNGN: {label: "Nigerian naira", country: "Nigeria", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address, decimals: 6},
  IDRX: {label: "Indonesian rupiah", country: "Indonesia", address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22" as Address, decimals: 2},
  wARS: {label: "Argentine peso", country: "Argentina", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D" as Address, decimals: 18},
  wBRL: {label: "Brazilian real", country: "Brazil", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0" as Address, decimals: 18},
  wMXN: {label: "Mexican peso", country: "Mexico", address: "0x337E7456B420bD3481e7FA61fA9850343d610d34" as Address, decimals: 18},
  wCOP: {label: "Colombian peso", country: "Colombia", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76" as Address, decimals: 18},
} as const;

export type PayoutToken = keyof typeof PAYOUT_TOKENS;
export const PAYOUT_TOKEN_KEYS = Object.keys(PAYOUT_TOKENS) as PayoutToken[];
export const isPayoutToken = (value: unknown): value is PayoutToken => typeof value === "string" && Object.hasOwn(PAYOUT_TOKENS, value);

export function formatPayout(token: PayoutToken, atomic: bigint | string): string {
  const value = Number(formatUnits(BigInt(atomic), PAYOUT_TOKENS[token].decimals));
  return `${value.toLocaleString("en-US", {maximumFractionDigits: 2})} ${token}`;
}
