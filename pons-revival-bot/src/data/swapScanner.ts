import type { Logger } from "pino";

/** Uniswap V3-style `Swap(address,address,int256,int256,uint160,uint128,int24)`. Pons coins
 * trade on V3-style pools — verified against a live pair, which emitted only this topic. */
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * Blocks per getLogs call. The RPC refuses any query matching more than 10,000 logs, and
 * measured chain-wide swap density is ~3,841 logs per 600 blocks, so 600 sits at roughly
 * 38% of the cap with headroom for busier periods. 600 blocks is also ~1 minute of chain
 * at Robinhood's ~101ms blocks.
 */
export const SWAP_SCAN_CHUNK_BLOCKS = 600;

export interface SwapScanResult {
  /** Lower-cased pool addresses that saw at least one swap in the scanned range. */
  pools: Set<string>;
  /** Highest block actually scanned; the caller persists this as its cursor. */
  reachedBlock: bigint;
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} responded ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/**
 * Reads which pools were traded in a block range, straight from the chain.
 *
 * This inverts how the bot finds active coins. Polling asks "is this coin trading?" once
 * per coin, which at 190,000 coins and a few thousand lookups per cycle means a coin that
 * starts moving is not looked at for hours — long after a 5x or 20x is over. Swap logs
 * answer the question the other way round: every coin being bought announces itself, so
 * one call per ~600 blocks surfaces all of them (measured: 247 distinct pools per minute of
 * chain) regardless of how many dormant coins exist.
 *
 * Only pool addresses are returned. Mapping those to tokens, and deciding what to do about
 * them, is the caller's job — this stays a thin, testable read.
 */
export async function scanRecentSwaps(
  rpcUrl: string,
  fromBlock: bigint,
  maxChunks: number,
  logger: Logger
): Promise<SwapScanResult> {
  const head = BigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as string);
  const pools = new Set<string>();
  if (fromBlock > head) return { pools, reachedBlock: head };

  let cursor = fromBlock;
  let reached = fromBlock > 0n ? fromBlock - 1n : 0n;

  for (let chunk = 0; chunk < maxChunks && cursor <= head; chunk += 1) {
    const span = BigInt(SWAP_SCAN_CHUNK_BLOCKS);
    const toBlock = cursor + span - 1n > head ? head : cursor + span - 1n;
    try {
      const logs = (await rpc(rpcUrl, "eth_getLogs", [
        {
          fromBlock: `0x${cursor.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [V3_SWAP_TOPIC],
        },
      ])) as { address: string }[];
      for (const log of logs) pools.add(log.address.toLowerCase());
      reached = toBlock;
    } catch (err) {
      // Stop at the last good block so the cursor retries this range rather than skipping
      // it: a skipped range is a coin whose move was never seen.
      logger.warn(
        { fromBlock: cursor.toString(), toBlock: toBlock.toString(), err: String(err) },
        "Swap scan chunk failed, will retry next cycle"
      );
      break;
    }
    cursor = toBlock + 1n;
  }

  return { pools, reachedBlock: reached };
}
