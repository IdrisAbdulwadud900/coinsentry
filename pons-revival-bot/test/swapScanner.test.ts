import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { scanRecentSwaps, V3_SWAP_TOPIC, SWAP_SCAN_CHUNK_BLOCKS } from "../src/data/swapScanner.js";

const logger = pino({ level: "silent" });

/** Serves a block head, then swap logs per getLogs call from a queue. */
function stubRpc(head: number, logsPerCall: { address: string }[][]) {
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
    stubRpc(1000, [[{ address: "0xAAA" }, { address: "0xaaa" }, { address: "0xBBB" }]]);

    const { pools } = await scanRecentSwaps("http://rpc", 900n, 1, logger);

    // One busy pool swapping repeatedly is still one coin to look at.
    expect([...pools].sort()).toEqual(["0xaaa", "0xbbb"]);
  });

  it("filters on the swap topic and walks forward in capped chunks", async () => {
    const calls = stubRpc(10_000, [[], [], []]);

    await scanRecentSwaps("http://rpc", 1n, 3, logger);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.topics).toEqual([V3_SWAP_TOPIC]);
    // Chunks must stay under the RPC's 10,000-log ceiling; contiguous, no gaps.
    expect(BigInt(calls[0]!.toBlock) - BigInt(calls[0]!.fromBlock) + 1n).toBe(BigInt(SWAP_SCAN_CHUNK_BLOCKS));
    expect(BigInt(calls[1]!.fromBlock)).toBe(BigInt(calls[0]!.toBlock) + 1n);
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
        return new Response(JSON.stringify({ result: [{ address: "0xAAA" }] }), { status: 200 });
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
