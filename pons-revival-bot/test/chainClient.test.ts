import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  readGraduationStatuses,
  scanTokenLaunches,
  readPoolMarketCaps,
  sqrtPriceX96ToPrice,
  readTokenBalance,
  readTotalSupply,
  readEarlyBuyConcentration,
  type ChainClient,
} from "../src/data/chainClient.js";

const logger = pino({ level: "silent" });

function mockClient(multicallImpl: (args: { contracts: { address: string; args: string[] }[] }) => Promise<unknown>): ChainClient {
  return { multicall: vi.fn(multicallImpl) } as unknown as ChainClient;
}

function makeLog(blockNumber: bigint, token: string) {
  return { blockNumber, args: { token, deployer: "0xDeployer" } };
}

describe("readGraduationStatuses", () => {
  it("maps successful multicall results to GraduationStatusResult, preserving call order", async () => {
    const client = mockClient(async ({ contracts }) =>
      contracts.map((_, i) => ({
        status: "success",
        result: [BigInt(i + 1) * 10n ** 18n, 42n * 10n ** 17n, i === 1],
      }))
    );

    const calls = [
      { factoryAddress: "0xFactory1", tokenAddress: "0xAAA" },
      { factoryAddress: "0xFactory1", tokenAddress: "0xBBB" },
    ];

    const results = await readGraduationStatuses(client, calls, 300, logger);

    expect(results).toEqual([
      {
        tokenAddress: "0xAAA",
        factoryAddress: "0xFactory1",
        pairedWei: 10n ** 18n,
        thresholdWei: 42n * 10n ** 17n,
        graduated: false,
      },
      {
        tokenAddress: "0xBBB",
        factoryAddress: "0xFactory1",
        pairedWei: 2n * 10n ** 18n,
        thresholdWei: 42n * 10n ** 17n,
        graduated: true,
      },
    ]);
  });

  it("chunks calls into multiple multicall invocations respecting batchSize", async () => {
    const multicall = vi.fn(async ({ contracts }: { contracts: unknown[] }) =>
      contracts.map(() => ({ status: "success", result: [1n, 2n, false] }))
    );
    const client = { multicall } as unknown as ChainClient;

    const calls = Array.from({ length: 5 }, (_, i) => ({
      factoryAddress: "0xFactory1",
      tokenAddress: `0xToken${i}`,
    }));

    const results = await readGraduationStatuses(client, calls, 2, logger);

    expect(multicall).toHaveBeenCalledTimes(3); // batches of 2, 2, 1
    expect(results).toHaveLength(5);
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(2);
    expect(multicall.mock.calls[1][0].contracts).toHaveLength(2);
    expect(multicall.mock.calls[2][0].contracts).toHaveLength(1);
  });

  it("skips individual calls that fail within an otherwise-successful batch", async () => {
    const client = mockClient(async () => [
      { status: "success", result: [1n, 2n, false] },
      { status: "failure", error: new Error("reverted") },
    ]);

    const calls = [
      { factoryAddress: "0xFactory1", tokenAddress: "0xAAA" },
      { factoryAddress: "0xFactory1", tokenAddress: "0xBBB" },
    ];

    const results = await readGraduationStatuses(client, calls, 300, logger);

    expect(results).toHaveLength(1);
    expect(results[0]?.tokenAddress).toBe("0xAAA");
  });

  it("retries a batch that throws, then skips it after exhausting retries, without throwing", async () => {
    vi.useFakeTimers();
    try {
      const multicall = vi.fn(async () => {
        throw new Error("RPC timeout");
      });
      const client = { multicall } as unknown as ChainClient;

      const calls = [{ factoryAddress: "0xFactory1", tokenAddress: "0xAAA" }];

      const promise = readGraduationStatuses(client, calls, 300, logger);
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([]);
      // initial attempt + MAX_MULTICALL_RETRIES(3) retries = 4 calls total
      expect(multicall).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers on a later attempt within the same batch after earlier attempts throw", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const multicall = vi.fn(async () => {
        attempt += 1;
        if (attempt < 3) throw new Error("rate limited");
        return [{ status: "success", result: [5n, 10n, true] }];
      });
      const client = { multicall } as unknown as ChainClient;

      const calls = [{ factoryAddress: "0xFactory1", tokenAddress: "0xAAA" }];

      const promise = readGraduationStatuses(client, calls, 300, logger);
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([
        { tokenAddress: "0xAAA", factoryAddress: "0xFactory1", pairedWei: 5n, thresholdWei: 10n, graduated: true },
      ]);
      expect(multicall).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues to subsequent batches after an earlier batch fails permanently", async () => {
    vi.useFakeTimers();
    try {
      const multicall = vi.fn(async ({ contracts }: { contracts: { args: string[] }[] }) => {
        const token = contracts[0]?.args[0];
        if (token === "0xBAD") throw new Error("always fails");
        return [{ status: "success", result: [1n, 2n, false] }];
      });
      const client = { multicall } as unknown as ChainClient;

      const calls = [
        { factoryAddress: "0xFactory1", tokenAddress: "0xBAD" },
        { factoryAddress: "0xFactory1", tokenAddress: "0xGOOD" },
      ];

      const promise = readGraduationStatuses(client, calls, 1, logger);
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([
        { tokenAddress: "0xGOOD", factoryAddress: "0xFactory1", pairedWei: 1n, thresholdWei: 2n, graduated: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scanTokenLaunches", () => {
  // The unbounded version of this scan is what took the bot down: after days offline the
  // backlog on a chain minting ~18.7k tokens/day pinned ~511MB of live objects and the
  // process died on its heap limit every cycle, which prevented it from ever catching up.
  it("stops at the per-cycle launch cap and reports where to resume, instead of scanning to the head", async () => {
    // Every 1,000-block chunk yields 3 launches; the head is 100,000 blocks away, so an
    // uncapped scan would accumulate ~300.
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [
      makeLog(fromBlock, `0xA-${fromBlock}`),
      makeLog(fromBlock, `0xB-${fromBlock}`),
      makeLog(fromBlock, `0xC-${fromBlock}`),
    ]);
    const client = { getBlockNumber: vi.fn(async () => 100_000n), getLogs } as unknown as ChainClient;

    const { launches, reachedBlock } = await scanTokenLaunches(client, "0xFactory1", 0n, 1000, logger, 10);

    expect(launches.length).toBeGreaterThanOrEqual(10);
    expect(launches.length).toBeLessThan(20);
    // Stopped early rather than running to the head...
    expect(reachedBlock).toBeLessThan(100_000n);
    // ...and reported the last block it actually scanned, so the caller's cursor resumes
    // there and no launch in between is skipped.
    expect(reachedBlock).toBe(3999n);
    expect(getLogs).toHaveBeenCalledTimes(4);
  });

  it("still scans through to the head when the backlog fits under the cap", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [makeLog(fromBlock, `0xT-${fromBlock}`)]);
    const client = { getBlockNumber: vi.fn(async () => 2_999n), getLogs } as unknown as ChainClient;

    const { launches, reachedBlock } = await scanTokenLaunches(client, "0xFactory1", 0n, 1000, logger, 10_000);

    expect(launches).toHaveLength(3);
    expect(reachedBlock).toBe(2_999n);
  });

  it("bisects a persistently-failing range (e.g. RPC timeout, not just the result-count cap) and still recovers all logs", async () => {
    vi.useFakeTimers();
    try {
      const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        const rangeSize = toBlock - fromBlock + 1n;
        if (rangeSize > 5000n) {
          throw new Error("log query timed out");
        }
        return [makeLog(fromBlock, `0xToken-${fromBlock}`)];
      });
      const client = { getBlockNumber: vi.fn(async () => 19999n), getLogs } as unknown as ChainClient;

      const promise = scanTokenLaunches(client, "0xFactory1", 0n, 20000, logger, 10_000);
      await vi.runAllTimersAsync();
      const { launches, reachedBlock } = await promise;

      // Initial 20000-block range fails, bisects to two 10000-block ranges (still fail),
      // each bisects again into two 5000-block ranges that finally succeed = 4 total.
      expect(launches).toHaveLength(4);
      expect(reachedBlock).toBe(19999n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the scan (without throwing or losing already-scanned progress) when a range fails all the way down to the bisection floor", async () => {
    vi.useFakeTimers();
    try {
      const getLogs = vi.fn(async () => {
        throw new Error("log query timed out");
      });
      const client = { getBlockNumber: vi.fn(async () => 1099n), getLogs } as unknown as ChainClient;

      // A 1000-block range is already below the bisection floor, so it should retry at
      // the same size (never bisect) and then give up on this cycle rather than recurse.
      const promise = scanTokenLaunches(client, "0xFactory1", 100n, 1000, logger, 10_000);
      await vi.runAllTimersAsync();
      const { launches, reachedBlock } = await promise;

      expect(launches).toEqual([]);
      expect(reachedBlock).toBe(99n);
      // initial attempt + MAX_CHUNK_RETRIES(3) retries = 4 calls, no bisection occurred
      expect(getLogs).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

const Q96 = 2n ** 96n;

describe("sqrtPriceX96ToPrice", () => {
  it("computes price1Per0 for a ratio of 0.01 (price 0.0001) with equal decimals", () => {
    // sqrtPrice = 0.01 -> price = 0.01^2 = 0.0001
    const sqrtPriceX96 = BigInt(Math.round(0.01 * Number(Q96)));
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(price).toBeCloseTo(0.0001, 8);
  });

  it("computes price1Per0 for an exact ratio of 2 (price 4) with equal decimals", () => {
    const sqrtPriceX96 = 2n * Q96;
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(price).toBeCloseTo(4, 6);
  });

  it("adjusts for decimals0 > decimals1 (e.g. 18-decimal token0 vs 6-decimal token1)", () => {
    const sqrtPriceX96 = 2n * Q96; // raw ratio^2 = 4
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
    // 4 * 10^(18-6) = 4e12
    expect(price).toBeCloseTo(4e12, -6);
  });

  it("adjusts for decimals0 < decimals1 (e.g. 6-decimal token0 vs 18-decimal token1)", () => {
    const sqrtPriceX96 = 2n * Q96; // raw ratio^2 = 4
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);
    // 4 * 10^(6-18) = 4e-12
    expect(price).toBeCloseTo(4e-12, 18);
  });

  it("supports inverting for token1 ordering (tracked token is token1)", () => {
    // If the tracked token is token1, its price in token0 units is 1 / price1Per0.
    const sqrtPriceX96 = 2n * Q96;
    const price1Per0 = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18); // 4
    const priceOfToken1InToken0 = 1 / price1Per0;
    expect(priceOfToken1InToken0).toBeCloseTo(0.25, 6);
  });

  it("returns a finite, non-negative number for an extreme low ratio", () => {
    const sqrtPriceX96 = 1n; // near-zero sqrtPrice
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(price).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(price)).toBe(true);
  });
});

describe("readPoolMarketCaps", () => {
  const TOKEN0 = "0x1000000000000000000000000000000000000a"; // lower address -> token0
  const TOKEN1_WETH = "0xf000000000000000000000000000000000000f"; // higher address -> token1

  function mockMulticallClient(
    handlers: (contracts: { address: string; functionName: string }[]) => unknown[]
  ): ChainClient {
    return {
      multicall: vi.fn(async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
        handlers(contracts)
      ),
    } as unknown as ChainClient;
  }

  it("returns [] immediately when ethUsdPrice is missing/invalid, without calling multicall", async () => {
    const multicall = vi.fn();
    const client = { multicall } as unknown as ChainClient;
    const results = await readPoolMarketCaps(
      client,
      [{ tokenAddress: TOKEN0, poolAddress: "0xPool", pairTokenAddress: TOKEN1_WETH }],
      0,
      300,
      logger
    );
    expect(results).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
  });

  it("computes market cap for a token0-ordered token using cached decimals/totalSupply (skips metadata calls)", async () => {
    const sqrtPriceX96 = 2n * Q96; // price1Per0 raw = 4, equal decimals -> price = 4 WETH per token
    const client = mockMulticallClient((contracts) =>
      contracts.map((c) => {
        expect(c.functionName).toBe("slot0");
        return { status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] };
      })
    );

    const results = await readPoolMarketCaps(
      client,
      [
        {
          tokenAddress: TOKEN0,
          poolAddress: "0xPool",
          pairTokenAddress: TOKEN1_WETH,
          tokenDecimals: 18,
          tokenTotalSupply: (1_000_000_000n * 10n ** 18n).toString(),
        },
      ],
      2000, // ETH/USD
      300,
      logger
    );

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.tokenAddress).toBe(TOKEN0);
    // priceInPairToken = 4 (token0 side, no inversion), priceUsd = 4 * 2000 = 8000
    expect(r.priceUsd).toBeCloseTo(8000, 2);
    // marketCap = priceUsd * totalSupplyHuman(1e9) = 8000 * 1e9
    expect(r.marketCapUsd).toBeCloseTo(8000 * 1_000_000_000, -2);
  });

  it("inverts price for a token1-ordered token", async () => {
    const sqrtPriceX96 = 2n * Q96; // price1Per0 raw = 4
    const client = mockMulticallClient((contracts) =>
      contracts.map((c) => {
        expect(c.functionName).toBe("slot0");
        return { status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] };
      })
    );

    // Tracked token address is numerically greater than pairToken -> tracked token is token1.
    const results = await readPoolMarketCaps(
      client,
      [
        {
          tokenAddress: TOKEN1_WETH,
          poolAddress: "0xPool",
          pairTokenAddress: TOKEN0,
          tokenDecimals: 18,
          tokenTotalSupply: (1_000_000_000n * 10n ** 18n).toString(),
        },
      ],
      2000,
      300,
      logger
    );

    expect(results).toHaveLength(1);
    const r = results[0]!;
    // priceInPairToken = 1/4 = 0.25, priceUsd = 0.25 * 2000 = 500
    expect(r.priceUsd).toBeCloseTo(500, 2);
  });

  it("fetches and caches decimals/totalSupply via multicall when not already known", async () => {
    const sqrtPriceX96 = 2n * Q96;
    const multicall = vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
      if (contracts[0]?.functionName === "decimals") {
        return [
          { status: "success", result: 18 },
          { status: "success", result: 1_000_000_000n * 10n ** 18n },
        ];
      }
      return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
    });
    const client = { multicall } as unknown as ChainClient;

    const results = await readPoolMarketCaps(
      client,
      [{ tokenAddress: TOKEN0, poolAddress: "0xPool", pairTokenAddress: TOKEN1_WETH }],
      2000,
      300,
      logger
    );

    expect(multicall).toHaveBeenCalledTimes(2); // one metadata batch + one slot0 batch
    expect(results).toHaveLength(1);
    expect(results[0]?.decimals).toBe(18);
  });

  it("omits a token when slot0 fails, without throwing", async () => {
    const client = mockMulticallClient((contracts) => contracts.map(() => ({ status: "failure", error: new Error("reverted") })));

    const results = await readPoolMarketCaps(
      client,
      [
        {
          tokenAddress: TOKEN0,
          poolAddress: "0xPool",
          pairTokenAddress: TOKEN1_WETH,
          tokenDecimals: 18,
          tokenTotalSupply: "1000000000000000000000000000",
        },
      ],
      2000,
      300,
      logger
    );

    expect(results).toEqual([]);
  });
});

describe("readTokenBalance", () => {
  it("returns the balance on a successful read", async () => {
    const readContract = vi.fn(async () => 12345n);
    const client = { readContract } as unknown as ChainClient;

    const balance = await readTokenBalance(client, "0xToken", "0xHolder");

    expect(balance).toBe(12345n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xToken", functionName: "balanceOf", args: ["0xHolder"] })
    );
  });

  it("returns null when the read fails, without throwing", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("reverted");
    });
    const client = { readContract } as unknown as ChainClient;

    const balance = await readTokenBalance(client, "0xToken", "0xHolder");

    expect(balance).toBeNull();
  });
});

describe("readTotalSupply", () => {
  it("returns the total supply on a successful read", async () => {
    const readContract = vi.fn(async () => 1_000_000n);
    const client = { readContract } as unknown as ChainClient;

    const supply = await readTotalSupply(client, "0xToken");

    expect(supply).toBe(1_000_000n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: "0xToken", functionName: "totalSupply" }));
  });

  it("returns null when the read fails, without throwing", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("reverted");
    });
    const client = { readContract } as unknown as ChainClient;

    const supply = await readTotalSupply(client, "0xToken");

    expect(supply).toBeNull();
  });
});

function makeTransferLog(from: string, to: string, value: bigint) {
  return { args: { from, to, value } };
}

describe("readEarlyBuyConcentration", () => {
  const pool = "0xPool";
  const totalSupply = 1000n;

  it("returns null immediately when totalSupply is not positive, without calling getLogs", async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, 0n, logger);

    expect(result).toBeNull();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("computes top-1 and top-5 percentages from Transfer events originating from the pool", async () => {
    const getLogs = vi.fn(async () => [
      makeTransferLog(pool, "0xBuyerA", 400n),
      makeTransferLog(pool, "0xBuyerB", 300n),
      makeTransferLog(pool, "0xBuyerC", 100n),
      makeTransferLog(pool, "0xBuyerD", 50n),
      makeTransferLog(pool, "0xBuyerE", 50n),
      makeTransferLog(pool, "0xBuyerF", 50n),
    ]);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toEqual({ topBuyerPct: 40, top5Pct: 90 });
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xToken", fromBlock: 100n, toBlock: 600n })
    );
  });

  it("excludes transfers not originating from the pool (wallet-to-wallet transfers)", async () => {
    const getLogs = vi.fn(async () => [
      makeTransferLog(pool, "0xBuyerA", 100n),
      makeTransferLog("0xSomeWallet", "0xBuyerB", 900n),
    ]);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toEqual({ topBuyerPct: 10, top5Pct: 10 });
  });

  it("excludes transfers to the zero address (e.g. burns)", async () => {
    const getLogs = vi.fn(async () => [
      makeTransferLog(pool, "0xBuyerA", 100n),
      makeTransferLog(pool, "0x0000000000000000000000000000000000000000", 900n),
    ]);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toEqual({ topBuyerPct: 10, top5Pct: 10 });
  });

  it("returns null when there are no matching pool-origin buys", async () => {
    const getLogs = vi.fn(async () => [makeTransferLog("0xSomeWallet", "0xBuyerA", 900n)]);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toBeNull();
  });

  it("returns null when getLogs fails, without throwing", async () => {
    const getLogs = vi.fn(async () => {
      throw new Error("RPC timeout");
    });
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toBeNull();
  });

  it("sums multiple buys by the same recipient before ranking", async () => {
    const getLogs = vi.fn(async () => [
      makeTransferLog(pool, "0xBuyerA", 200n),
      makeTransferLog(pool, "0xBuyerA", 200n),
      makeTransferLog(pool, "0xBuyerB", 100n),
    ]);
    const client = { getLogs } as unknown as ChainClient;

    const result = await readEarlyBuyConcentration(client, "0xToken", 100n, 500, pool, totalSupply, logger);

    expect(result).toEqual({ topBuyerPct: 40, top5Pct: 50 });
  });
});
