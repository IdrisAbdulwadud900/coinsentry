import type { Logger } from "pino";

/** Uniswap V3-style `Swap(address,address,int256,int256,uint160,uint128,int24)`. Pons coins
 * trade on V3-style pools — verified against a live pair, which emitted only this topic. */
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * Uniswap V4 `Swap`, emitted by the singleton PoolManager rather than by a pool contract.
 *
 * Watching only V3 made the larger half of the chain invisible: measured over the same 600
 * blocks, V4 produced 5,424 swaps against V3's 3,841. A coin trading on V4 — which
 * DexScreener labels "v4" and identifies by a 32-byte pool id rather than a contract
 * address — could be bought hundreds of times an hour without this scan noticing.
 */
export const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

/**
 * Blocks per getLogs call. The RPC refuses any query matching more than 10,000 logs.
 * Measured density is ~3,841 V3 swaps and ~5,424 V4 swaps per 600 blocks; scanning both
 * venues together would sit at ~9,265, right against the ceiling. 300 blocks halves that
 * to a comfortable ~4,600 and is still ~30 seconds of chain at Robinhood's ~101ms blocks.
 */
export const SWAP_SCAN_CHUNK_BLOCKS = 300;

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
          // Either venue's swap event; getLogs treats a nested array as OR.
          topics: [[V3_SWAP_TOPIC, V4_SWAP_TOPIC]],
        },
      ])) as { address: string; topics: string[] }[];
      for (const log of logs) {
        // V3 pools are contracts, so the log's address IS the pool. V4 routes every pool
        // through one PoolManager, so the address is useless and the pool is the 32-byte
        // id in topic 1 — which is exactly what DexScreener reports as the pair for a v4
        // coin, so both forms match the same stored column.
        const isV4 = log.topics[0]?.toLowerCase() === V4_SWAP_TOPIC;
        const pool = isV4 ? log.topics[1] : log.address;
        if (pool) pools.add(pool.toLowerCase());
      }
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
