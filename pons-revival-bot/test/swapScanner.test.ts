import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { scanRecentSwaps, V3_SWAP_TOPIC, V4_SWAP_TOPIC, SWAP_SCAN_CHUNK_BLOCKS } from "../src/data/swapScanner.js";

const logger = pino({ level: "silent" });

/** A V3 swap log: the pool is the emitting contract. */
const v3 = (address: string) => ({ address, topics: [V3_SWAP_TOPIC] });
/** A V4 swap log: every pool shares the PoolManager address, so the pool is the id in
 * topic 1 — the same 32-byte value DexScreener reports as a v4 coin's pair. */
const v4 = (poolId: string) => ({ address: "0xPoolManager", topics: [V4_SWAP_TOPIC, poolId] });

/** Serves a block head, then swap logs per getLogs call from a queue. */
function stubRpc(head: number, logsPerCall: { address: string; topics?: string[] }[][]) {
  const calls: { fromBlock: string; toBlock: string; topics: string[] }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "eth_blockNumber") {
        return new Response(JSON.stringify({ result: `0x${head.toString(16)}` }), { status: 200 });
      }
      calls.push(params[0]);
      const result = logsPerCall[i++] ?? [];
      return new Response(JSON.stringify({ result }), { status: 200 });
    })
  );
  return calls;
}

describe("scanRecentSwaps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the distinct pools that traded, deduplicated across many swaps", async () => {
    stubRpc(1000, [[v3("0xAAA"), v3("0xaaa"), v3("0xBBB")]]);

    const { pools } = await scanRecentSwaps("http://rpc", 900n, 1, logger);

    // One busy pool swapping repeatedly is still one coin to look at.
    expect([...pools].sort()).toEqual(["0xaaa", "0xbbb"]);
  });

  it("filters on the swap topic and walks forward in capped chunks", async () => {
    const calls = stubRpc(10_000, [[], [], []]);

    await scanRecentSwaps("http://rpc", 1n, 3, logger);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.topics).toEqual([[V3_SWAP_TOPIC, V4_SWAP_TOPIC]]);
    // Chunks must stay under the RPC's 10,000-log ceiling; contiguous, no gaps.
    expect(BigInt(calls[0]!.toBlock) - BigInt(calls[0]!.fromBlock) + 1n).toBe(BigInt(SWAP_SCAN_CHUNK_BLOCKS));
    expect(BigInt(calls[1]!.fromBlock)).toBe(BigInt(calls[0]!.toBlock) + 1n);
  });

  it("identifies a V4 pool by its id, not the shared PoolManager address", async () => {
    const POOL = "0x4dd2736e0a2c4dde3fdfaecc1cf625ec01832cddbde8995b95dd86521d60e734";
    stubRpc(1000, [[v4(POOL), v4(POOL), v3("0xV3POOL")]]);

    const { pools } = await scanRecentSwaps("http://rpc", 900n, 1, logger);

    // Using log.address for a V4 swap would collapse every V4 coin on the chain into one
    // "pool" and identify none of them.
    expect([...pools].sort()).toEqual([POOL, "0xv3pool"].sort());
    expect(pools.has("0xpoolmanager")).toBe(false);
  });

  it("never scans past the chain head", async () => {
    const calls = stubRpc(1_050, [[]]);

    const { reachedBlock } = await scanRecentSwaps("http://rpc", 1_000n, 5, logger);

    expect(calls).toHaveLength(1);
    expect(BigInt(calls[0]!.toBlock)).toBe(1_050n);
    expect(reachedBlock).toBe(1_050n);
  });

  it("stops at the last good block on failure so the range is retried, not skipped", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { method } = JSON.parse(init.body);
        if (method === "eth_blockNumber") {
          return new Response(JSON.stringify({ result: "0x4e20" }), { status: 200 });
        }
        call += 1;
        if (call === 2) return new Response(JSON.stringify({ error: { message: "limit exceeded" } }), { status: 200 });
        return new Response(JSON.stringify({ result: [{ address: "0xAAA", topics: [V3_SWAP_TOPIC] }] }), { status: 200 });
      })
    );

    const { pools, reachedBlock } = await scanRecentSwaps("http://rpc", 1n, 4, logger);

    // First chunk's find is kept; the cursor stops before the failed range so nothing is
    // silently lost — a skipped range is a coin whose move was never seen.
    expect([...pools]).toEqual(["0xaaa"]);
    expect(reachedBlock).toBe(BigInt(SWAP_SCAN_CHUNK_BLOCKS));
  });

  it("does nothing when the cursor is already ahead of the head", async () => {
    const calls = stubRpc(500, [[]]);

    const { pools, reachedBlock } = await scanRecentSwaps("http://rpc", 900n, 3, logger);

    expect(calls).toHaveLength(0);
    expect(pools.size).toBe(0);
    expect(reachedBlock).toBe(500n);
  });
});
