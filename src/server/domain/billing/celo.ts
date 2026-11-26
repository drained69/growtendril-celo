import { createPublicClient, http, parseAbiItem, type Address, type Hash, type Log } from "viem";
import { assertCeloMainnet } from "@/server/integrations/celo/client";
import { CELO } from "@/server/integrations/celo/config";

/** Celo USDC uses ERC-20 transfers with 6 decimals. Native CELO never credits a USDC invoice. */
export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let client: ReturnType<typeof createPublicClient> | null = null;
const rpc = () => (client ??= createPublicClient({ transport: http(CELO.rpcUrl, { timeout: 15_000, retryCount: 2 }) }));

export const isAddress = (a?: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a);
export const isTxHash = (h?: string | null): h is string => !!h && /^0x[0-9a-fA-F]{64}$/.test(h);

export async function currentBlock(): Promise<bigint> {
  await assertCeloMainnet();
  return rpc().getBlockNumber();
}

export interface IncomingPayment {
  txHash: string;
  from: string;
  amountMicro: number;
  blockNumber: bigint;
}

export interface UsdcTransfer extends IncomingPayment {
  to: string;
}

/** USDC Transfer logs filtered by sender or recipient, in RPC-friendly chunks. */
async function scan(filter: { from?: string; to?: string }, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
  await assertCeloMainnet();
  const out: UsdcTransfer[] = [];
  const CHUNK = 5_000n;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
    const logs = await rpc().getLogs({ address: CELO.usdc as Address, event: TRANSFER, args: { from: filter.from as Address | undefined, to: filter.to as Address | undefined }, fromBlock: start, toBlock: end });
    for (const l of logs) {
      if (l.args.value == null || !l.args.from || !l.args.to) continue;
      out.push({ txHash: l.transactionHash, from: l.args.from, to: l.args.to, amountMicro: Number(l.args.value), blockNumber: l.blockNumber });
    }
  }
  return out;
}

/** USDC transfers to `to` since `fromBlock` (USDC contract only). */
export async function transfersTo(to: string, fromBlock: bigint, toBlock?: bigint): Promise<IncomingPayment[]> {
  return scan({ to }, fromBlock, toBlock ?? (await currentBlock()));
}

/** USDC transfers out of `from` between two blocks (USDC contract only). */
export async function transfersFrom(from: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
  return scan({ from }, fromBlock, toBlock);
}

const topicAddress = (t: string) => `0x${t.slice(26)}`.toLowerCase();

/** Every USDC movement in a mined transaction, in micro-USDC. */
function movesIn(logs: Log[], tx: { from: string; to: string | null; value: bigint } | null): { from: string; to: string; micro: bigint }[] {
  const transfers = (emitter: string) => logs.filter((l) => l.address.toLowerCase() === emitter.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length >= 3);
  return transfers(CELO.usdc).map((l) => ({ from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!), micro: BigInt(l.data) }));
}

export interface PayoutReceipt {
  /** "pending": not mined yet. */
  status: "pending" | "success" | "reverted";
  /** USDC this transaction moved from `from` to `to`. */
  toRecipientMicro: number;
  /** Any other USDC this transaction moved out of `from`. */
  elsewhere: { to: string; amountMicro: number }[];
  blockNumber?: bigint;
}

/** What a payout transaction actually did on Celo: how much went from `from` to `to`, and what else left `from`. */
export async function payoutInTx(hash: string, from: string, to: string): Promise<PayoutReceipt> {
  await assertCeloMainnet();
  const [receipt, tx] = await Promise.all([rpc().getTransactionReceipt({ hash: hash as Hash }).catch(() => null), rpc().getTransaction({ hash: hash as Hash }).catch(() => null)]);
  if (!receipt) return { status: "pending", toRecipientMicro: 0, elsewhere: [] };
  if (receipt.status !== "success") return { status: "reverted", toRecipientMicro: 0, elsewhere: [], blockNumber: receipt.blockNumber };
  const src = from.toLowerCase();
  const dst = to.toLowerCase();
  let toRecipient = 0n;
  const elsewhere = new Map<string, bigint>();
  for (const m of movesIn(receipt.logs, tx)) {
    if (m.from !== src) continue;
    if (m.to === dst) toRecipient += m.micro;
    else elsewhere.set(m.to, (elsewhere.get(m.to) ?? 0n) + m.micro);
  }
  return { status: "success", toRecipientMicro: Number(toRecipient), elsewhere: [...elsewhere].map(([addr, v]) => ({ to: addr, amountMicro: Number(v) })), blockNumber: receipt.blockNumber };
}

/** What a transaction paid to `to`, in micro-USDC. Null if the transaction failed or isn't mined yet. */
export async function paymentInTx(hash: string, to: string): Promise<{ amountMicro: number; from: string; blockNumber: bigint } | null> {
  await assertCeloMainnet();
  const [receipt, tx] = await Promise.all([rpc().getTransactionReceipt({ hash: hash as Hash }).catch(() => null), rpc().getTransaction({ hash: hash as Hash }).catch(() => null)]);
  if (!receipt || !tx || receipt.status !== "success") return null;
  const target = to.toLowerCase();
  const micro = movesIn(receipt.logs, tx)
    .filter((m) => m.to === target)
    .reduce((n, m) => n + m.micro, 0n);
  return { amountMicro: Number(micro), from: tx.from, blockNumber: receipt.blockNumber };
}
