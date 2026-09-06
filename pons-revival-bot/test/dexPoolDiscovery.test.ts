import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { DiscoveryStateRepo } from "../src/data/discoveryStateRepo.js";
import {
  runDexPoolDiscovery,
  buildPoolChainConfigs,
  ROBINHOOD_POOL_SOURCES,
  ROBINHOOD_QUOTE_ASSETS,
  BSC_POOL_SOURCES,
  ETHEREUM_POOL_SOURCES,
} from "../src/data/dexPoolDiscovery.js";
import type { DexScreenerClient } from "../src/data/dexscreener.js";

const logger = pino({ level: "silent" });
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const DORK = "0xd707d1a75a85cca5bb0491663ff74324fd0f7b03";

/** 32-byte indexed topic form of an address. */
const topicFor = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;

describe("runDexPoolDiscovery", () => {
  let db: Db;
  let tokenRepo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tokenRepo = new TokenRepo(db);
  });

  function deps(opts: { logs?: unknown[]; pairs?: unknown[] } = {}) {
    // The scanner talks raw JSON-RPC, so each chain is just a URL.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const method = JSON.parse(init.body).method;
        const result = method === "eth_blockNumber" ? "0xf4240" : (opts.logs ?? []);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      })
    );
    const dex = { lookupBatch: vi.fn(async () => opts.pairs ?? []) } as unknown as DexScreenerClient;
    return {
      discoveryStateRepo: new DiscoveryStateRepo(db),
      tokenRepo,
      dex,
      minLiquidityUsd: 200,
      logger,
    };
  }

  const robinhoodOnly = [
    {
      chain: "robinhood",
      rpcUrl: "https://rpc.example",
      chunkBlocks: 20_000,
      backfillBlocks: 36_000,
      // Backward sweep off by default here so the existing forward-scan expectations stay
      // exact; the backfill has its own tests below.
      historyBlocks: 0,
      backfillChunksPerCycle: 0,
      maxHistoricalInsertsPerCycle: 300,
      maxForwardChunksPerCycle: 50,
      quoteAssets: ROBINHOOD_QUOTE_ASSETS,
      sources: [ROBINHOOD_POOL_SOURCES[0]!],
    },
  ];

  afterEach(() => vi.unstubAllGlobals());

  // A Uniswap V4 Initialize log: topic1 is the pool id, tokens are in topics 2 and 3.
  const v4Log = { topics: ["0xdd46", "0xpoolid", topicFor(WETH), topicFor(DORK)] };

  const dorkPair = {
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: "0xb5c5735de7dea217b6db067bda92b53ae2489154",
    baseToken: { address: DORK, symbol: "DORK", name: "DORK LORD" },
    liquidity: { usd: 38958 },
    marketCap: 290253,
    info: { imageUrl: "https://img.example/dork.png" },
  };

  it("discovers a token launched straight onto a DEX, outside the Pons launchpad", async () => {
    const d = deps({ logs: [v4Log], pairs: [dorkPair] });

    const inserted = await runDexPoolDiscovery(d, robinhoodOnly);

    expect(inserted).toBe(1);
    const token = tokenRepo.findByAddress(DORK);
    expect(token?.symbol).toBe("DORK");
    expect(token?.chain).toBe("robinhood");
    expect(token?.status).toBe("active");
    // No Pons factory, so the graduation/bonding-curve sweeps correctly skip it.
    expect(token?.factory_address).toBeNull();
  });

  it("never tracks the quote asset side of a pool", async () => {
    const d = deps({ logs: [v4Log], pairs: [dorkPair] });

    await runDexPoolDiscovery(d, robinhoodOnly);

    expect(tokenRepo.findByAddress(WETH)).toBeUndefined();
  });

  it("advances its own cursor so the next scan resumes where this one stopped", async () => {
    const d = deps({ logs: [], pairs: [] });

    await runDexPoolDiscovery(d, robinhoodOnly);

    const cursor = d.discoveryStateRepo.getLastScannedBlock(`robinhood:${ROBINHOOD_POOL_SOURCES[0]!.label}`);
    expect(cursor).toBe(1_000_001n);
  });

  // The gap these cover cost a real alert: ABE (0x759d161b…), a Uniswap V4 pool created
  // days before pool discovery existed, ran $3k -> $26k while completely absent from the
  // database, because the forward cursor starts at the head and never looks behind it.
  describe("backward history sweep", () => {
    /** Serves pool logs ONLY for blocks below the forward scan's starting point, so a hit
     * proves the backward sweep found it rather than the ordinary forward scan. */
    function historyOnlyDeps(forwardStart: number) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
          const call = JSON.parse(init.body);
          if (call.method === "eth_blockNumber") {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xf4240" }), { status: 200 });
          }
          const from = Number(BigInt(call.params[0].fromBlock));
          const result = from < forwardStart ? [v4Log] : [];
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
        })
      );
      const dex = { lookupBatch: vi.fn(async () => [dorkPair]) } as unknown as DexScreenerClient;
      return { discoveryStateRepo: new DiscoveryStateRepo(db), tokenRepo, dex, minLiquidityUsd: 200, logger };
    }

    const withBackfill = [{ ...robinhoodOnly[0]!, historyBlocks: 200_000, backfillChunksPerCycle: 2 }];

    it("discovers a token whose pool was created before the forward scan ever started", async () => {
      const d = historyOnlyDeps(964_000);

      const inserted = await runDexPoolDiscovery(d, withBackfill);

      expect(inserted).toBe(1);
      expect(tokenRepo.findByAddress(DORK)).toBeDefined();
    });

    it("walks further back each cycle and stops at the history floor", async () => {
      const d = historyOnlyDeps(964_000);
      const key = `robinhood:${ROBINHOOD_POOL_SOURCES[0]!.label}:backfill`;

      await runDexPoolDiscovery(d, withBackfill);
      // Two 20k chunks below the forward start of 964,000.
      expect(d.discoveryStateRepo.getLastScannedBlock(key)).toBe(924_000n);

      await runDexPoolDiscovery(d, withBackfill);
      expect(d.discoveryStateRepo.getLastScannedBlock(key)).toBe(884_000n);

      // Floor is head - historyBlocks = 800,000; the sweep clamps there and then stops
      // doing any further work no matter how many cycles run.
      for (let i = 0; i < 10; i += 1) await runDexPoolDiscovery(d, withBackfill);
      expect(d.discoveryStateRepo.getLastScannedBlock(key)).toBe(800_000n);
    });

    it("does no historical work when the sweep is disabled", async () => {
      const d = historyOnlyDeps(964_000);

      const inserted = await runDexPoolDiscovery(d, robinhoodOnly);

      expect(inserted).toBe(0);
      expect(d.discoveryStateRepo.getLastScannedBlock(`robinhood:${ROBINHOOD_POOL_SOURCES[0]!.label}:backfill`)).toBeUndefined();
    });
  });

  it("leaves an already-tracked Pons token untouched", async () => {
    tokenRepo.insertIfNew(DORK, "PONSY", "Pons Token", "0xp", "active", null, "0xFactory1", Date.now());
    const d = deps({ logs: [v4Log], pairs: [dorkPair] });

    const inserted = await runDexPoolDiscovery(d, robinhoodOnly);

    expect(inserted).toBe(0);
    expect(tokenRepo.findByAddress(DORK)?.symbol).toBe("PONSY");
    expect(d.dex.lookupBatch).not.toHaveBeenCalled();
  });

  it("tracks a below-floor token as unindexed rather than active", async () => {
    const thin = { ...dorkPair, liquidity: { usd: 20 } };
    const d = deps({ logs: [v4Log], pairs: [thin] });

    await runDexPoolDiscovery(d, robinhoodOnly);

    expect(tokenRepo.findByAddress(DORK)?.status).toBe("unindexed");
  });
});

describe("buildPoolChainConfigs", () => {
  it("scans only the chains that have an RPC configured", () => {
    const only = buildPoolChainConfigs({ robinhood: "https://rh.example" });
    expect(only.map((c) => c.chain)).toEqual(["robinhood"]);

    const all = buildPoolChainConfigs({
      robinhood: "https://rh.example",
      bsc: "https://bsc.example",
      ethereum: "https://eth.example",
    });
    expect(all.map((c) => c.chain)).toEqual(["robinhood", "bsc", "ethereum"]);
  });

  it("sizes each chain's block window to its own block time", () => {
    const all = buildPoolChainConfigs({
      robinhood: "https://rh.example",
      bsc: "https://bsc.example",
      ethereum: "https://eth.example",
    });
    const byChain = new Map(all.map((c) => [c.chain, c]));
    // ~1 hour of blocks each: 101ms, 3s and 12s block times respectively.
    expect(byChain.get("robinhood")!.backfillBlocks).toBe(36_000);
    expect(byChain.get("bsc")!.backfillBlocks).toBe(1_200);
    // Ethereum stays narrow — free RPCs reject wider windows as archive requests.
    expect(byChain.get("ethereum")!.backfillBlocks).toBe(300);
  });

  it("carries the verified factories for each chain", () => {
    const all = buildPoolChainConfigs({ robinhood: "r", bsc: "b", ethereum: "e" });
    const byChain = new Map(all.map((c) => [c.chain, c]));
    expect(byChain.get("bsc")!.sources).toEqual(BSC_POOL_SOURCES);
    expect(byChain.get("ethereum")!.sources).toEqual(ETHEREUM_POOL_SOURCES);
  });
});
