import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { SnapshotRepo } from "../src/data/snapshotRepo.js";
import { AlertRepo } from "../src/data/alertRepo.js";
import { DiscoveryStateRepo } from "../src/data/discoveryStateRepo.js";
import { OutcomeRepo } from "../src/data/outcomeRepo.js";
import { SettingsRepo } from "../src/data/settingsRepo.js";
import {
  runGraduationSweep,
  runPollCycle,
  runUngraduatedFastSweep,
  runMomentumFastSweep,
  runNonPonsFastSweep,
  runObserverSweep,
  rateConviction,
  activeChains,
  FOCUS_CHAIN_SETTING_KEY,
  effectiveBundleCapPct,
  BUNDLE_CAP_SETTING_KEY,
  type PollerDeps,
} from "../src/engine/poller.js";
import type { ChainClient } from "../src/data/chainClient.js";
import type { Notifier } from "../src/engine/notifier.js";
import type { DexScreenerClient } from "../src/data/dexscreener.js";
import type { EthPriceClient } from "../src/data/ethPrice.js";
import type { BlockscoutClient } from "../src/data/blockscoutClient.js";
import type { SolanaClient } from "../src/data/solanaClient.js";
import type { JupiterClient } from "../src/data/jupiterClient.js";

const logger = pino({ level: "silent" });

const classifierConfig = {
  deadMinAgeHours: 24,
  deadVolume24hUsd: 500,
  deadMinBuys1h: 3,
  deadConfirmPolls: 6,
  revivalVolumeMultiple: 8,
  revivalMinVolume1hUsd: 300,
  revivalMinBuys1h: 5,
  revivalLiquidityFloorPct: 0.8,
  revivalConfirmPolls: 2,
  demoteConfirmPolls: 3,
  alertCooldownHours: 6,
};

function baseDeps(
  db: Db,
  overrides: Partial<PollerDeps> = {}
): { deps: PollerDeps; tokenRepo: TokenRepo; outcomeRepo: OutcomeRepo; settingsRepo: SettingsRepo } {
  const tokenRepo = new TokenRepo(db);
  const outcomeRepo = new OutcomeRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const deps: PollerDeps = {
    chainClient: { multicall: vi.fn(async () => []) } as unknown as ChainClient,
    discoveryStateRepo: new DiscoveryStateRepo(db),
    tokenRepo,
    snapshotRepo: new SnapshotRepo(db),
    alertRepo: new AlertRepo(db),
    dex: { lookupBatch: vi.fn(async () => []) } as unknown as DexScreenerClient,
    notifier: { sendAlert: vi.fn(async () => {}) } as unknown as Notifier,
    logger,
    classifierConfig,
    factories: [],
    dexScreenerChainId: "robinhood",
    discoveryChunkBlocks: 500_000,
    discoveryMinLiquidityUsd: 200,
    spamDeployerThreshold: 15,
    unindexedRecheckHours: 24,
    graduationCheckBatchSize: 300,
    snapshotRetentionDays: 7,
    telegramChatId: "12345",
    dryRunAlerts: false,
    ethPriceClient: { getUsdPrice: vi.fn(async () => 3500) } as unknown as EthPriceClient,
    blockscoutByChain: {
      robinhood: {
        fetchHolders: vi.fn(async () => null),
        fetchTokenIconUrl: vi.fn(async () => null),
        fetchTokenMeta: vi.fn(async () => null),
      } as unknown as BlockscoutClient,
    },
    solanaClient: { fetchMintSafety: vi.fn(async () => null) } as unknown as SolanaClient,
    jupiterClient: { fetchRecentTokens: vi.fn(async () => []) } as unknown as JupiterClient,
    solanaSpamDevMints: 50,
    minAlertConviction: "low",
    breakoutVolumeMultiple: 5,
    breakoutMinVolume1hUsd: 3000,
    breakoutMinBuys1h: 30,
    reversalMultiple: 1.4,
    breakoutCooldownHours: 12,
    ungraduatedFastWindowHours: 6,
    marketCapAlertTiersUsd: [2000, 3000, 4000, 5000, 6000],
    earlyMomentumMaxAgeMinutes: 10_080,
    earlyMomentumMinBuys5m: 10,
    earlyMomentumMinVolume5mUsd: 1000,
    momentumRealertMultiple: 3,
    performanceMilestoneMultiples: [2, 3, 5, 10, 20, 50, 100],
    earlyBuyWindowBlocks: 500,
    outcomeRepo,
    settingsRepo,
    marketScanBatchSize: 30_000,
    noMarketDataDemoteStreak: 3,
    minLiquidityToMcapPct: 2,
    enabledChains: ["robinhood"],
    dexPoolDiscoveryEnabled: false,
    poolChainConfigs: [],
    ...overrides,
  };
  return { deps, tokenRepo, outcomeRepo, settingsRepo };
}

/**
 * Tokens must be at least MIN_ALERT_AGE_MINUTES (60) old to alert at all: the strategy is
 * coins that suddenly get bid, not fresh launches. Seeding fixtures at `now` made every
 * token zero minutes old, so these tests would only ever have re-proved the age gate.
 */
const ALERTABLE_AGE = (now: number): number => now - 2 * 60 * 60 * 1000;

describe("runGraduationSweep", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  // A pair that satisfies the entry gate: known sub-$11k market cap and a link.
  function gatePassingPair(marketCap = 4500) {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      marketCap,
      txns: { h1: { buys: 30, sells: 10 } },
      info: { websites: [{ url: "https://foo.example" }] },
    };
  }

  it("does nothing (and never calls multicall) when no tokens are due", async () => {
    const { deps } = baseDeps(db);
    await runGraduationSweep(deps, Date.now());
    expect(deps.chainClient.multicall).not.toHaveBeenCalled();
  });

  it("marks a token graduated and sends a live alert when dryRunAlerts is false", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [gatePassingPair()]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    const now = Date.now();
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runGraduationSweep(deps, now);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.graduated).toBe(1);
    expect(token?.graduation_paired_wei).toBe((5n * 10n ** 18n).toString());
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]?.[0]).toBe(deps.telegramChatId);
  });

  it("does not send a live alert when dryRunAlerts is true, but still marks graduated", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: true,
    });

    const now = Date.now();
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runGraduationSweep(deps, now);

    expect(tokenRepo.findByAddress("0xaaa")?.graduated).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("threads the DexScreener pair's website link into the graduation alert HTML", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [gatePassingPair()]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    const now = Date.now();
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runGraduationSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });

  it("updates progress without marking graduated or alerting when still below threshold", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [1n * 10n ** 18n, 42n * 10n ** 17n, false] }]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
    });

    const now = Date.now();
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runGraduationSweep(deps, now);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.graduated).toBe(0);
    expect(token?.graduation_paired_wei).toBe((1n * 10n ** 18n).toString());
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("threads a resolved early-buy-concentration reading into the graduation alert", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const getLogs = vi.fn(async () => [
      { args: { from: "0xpoolaaa", to: "0xbuyer1", value: 300_000n * 10n ** 18n } },
      { args: { from: "0xpoolaaa", to: "0xbuyer2", value: 100_000n * 10n ** 18n } },
      { args: { from: "0xsomeoneelse", to: "0xbuyer3", value: 999_000n * 10n ** 18n } }, // not from pool -> excluded
    ]);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [gatePassingPair()]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall, getLogs } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    const now = Date.now();
    tokenRepo.insertIfNew(
      "0xAAA",
      "FOO",
      "Foo Token",
      "0xpairAAA",
      "active",
      null,
      "0xFactory1",
      ALERTABLE_AGE(now),
      "0xPoolAAA",
      null,
      "12345"
    );
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runGraduationSweep(deps, now);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    // (300k + 100k) / 1,000,000 = 40% top-5; 300k / 1,000,000 = 30% top-1
    expect(html).toContain("bundle 40%");
  });

  it("omits the early-buy-concentration line when the token has no launch_block (legacy token)", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const getLogs = vi.fn(async () => []);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [gatePassingPair()]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall, getLogs } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    const now = Date.now();
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now), "0xPoolAAA");

    await runGraduationSweep(deps, now);

    expect(getLogs).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).not.toContain("Early Buy Concentration");
  });

  it("swallows errors from the chain client and does not throw", async () => {
    vi.useFakeTimers();
    try {
      const multicall = vi.fn(async () => {
        throw new Error("RPC down");
      });
      const { deps, tokenRepo } = baseDeps(db, { chainClient: { multicall } as unknown as ChainClient });

      const now = Date.now();
      tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

      const promise = runGraduationSweep(deps, now);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();

      expect(tokenRepo.findByAddress("0xaaa")?.graduated).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runPollCycle graduation wiring", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("invokes the graduation sweep as part of a full poll cycle and marks tokens graduated end-to-end", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 42n * 10n ** 17n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [
      {
        chainId: "robinhood",
        dexId: "test",
        pairAddress: "0xpairAAA",
        baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
        liquidity: { usd: 5000 },
        marketCap: 4500,
        txns: { h1: { buys: 30, sells: 10 } },
        info: { websites: [{ url: "https://foo.example" }] },
      },
    ]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

    await runPollCycle(deps);

    expect(tokenRepo.findByAddress("0xaaa")?.graduated).toBe(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("continues the cycle without throwing when the graduation sweep step fails unexpectedly", async () => {
    vi.useFakeTimers();
    try {
      const { deps, tokenRepo } = baseDeps(db, {
        chainClient: {
          multicall: vi.fn(async () => {
            throw new Error("boom");
          }),
        } as unknown as ChainClient,
      });

      tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

      const promise = runPollCycle(deps);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runUngraduatedFastSweep", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("does nothing when no ungraduated tokens are due", async () => {
    const { deps } = baseDeps(db);
    await runUngraduatedFastSweep(deps, Date.now());
    expect(deps.chainClient.multicall).not.toHaveBeenCalled();
  });

  it("includes still-'unindexed' tokens (the core gap this sweep fixes)", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [0n, 42n * 10n ** 17n, false] }]);
    const { deps, tokenRepo } = baseDeps(db, { chainClient: { multicall } as unknown as ChainClient });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "unindexed", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

    await runUngraduatedFastSweep(deps, Date.now());

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findByAddress("0xaaa")?.graduation_threshold_wei).toBe((42n * 10n ** 17n).toString());
  });

  it("sends one alert covering all newly crossed tiers and records the highest tier index", async () => {
    // On-chain pool price -> priceUsd = 0.0035 at the mocked $3500/ETH price; totalSupply of
    // 1,000,000 tokens -> marketCapUsd = 3500, crossing the 2000 and 3000 tiers (but not 4000).
    const Q96 = 2n ** 96n;
    const sqrtPriceX96 = Q96 / 1000n; // price1Per0 = (1/1000)^2 = 1e-6
    const multicall = vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
      if (contracts[0]?.functionName === "graduationStatus") {
        return [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }];
      }
      if (contracts[0]?.functionName === "slot0") {
        return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
      }
      return contracts.map(() => ({ status: "failure" }));
    });
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [
      {
        chainId: "robinhood",
        dexId: "test",
        pairAddress: "0xpairAAA",
        baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
        liquidity: { usd: 5000 },
        marketCap: 3500,
        txns: { h1: { buys: 30, sells: 10 } },
        info: { websites: [{ url: "https://foo.example" }] },
      },
    ]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    // Tracked token address sorts below the pair-token (WETH) address -> tracked token is token0.
    tokenRepo.insertIfNew(
      "0xAAA",
      "FOO",
      "Foo Token",
      "0xpairAAA",
      "active",
      null,
      "0xFactory1",
      ALERTABLE_AGE(Date.now()),
      "0xPoolAAA",
      "0xfffPairToken"
    );
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, Date.now());

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findByAddress("0xaaa")?.graduation_alert_tier).toBe(2);
  });

  it("never re-alerts an already-crossed tier", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));
    tokenRepo.setGraduationAlertTier("0xaaa", 2); // already alerted through the 3000 tier

    await runUngraduatedFastSweep(deps, Date.now());

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("skips tier alerting (but still updates progress) when no ETH/USD price is available", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      ethPriceClient: { getUsdPrice: vi.fn(async () => null) } as unknown as EthPriceClient,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

    await runUngraduatedFastSweep(deps, Date.now());

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.graduation_paired_wei).toBe((1n * 10n ** 18n).toString());
  });

  it("sends the graduation alert directly when a token graduates via the fast path (bug fix: previously silently dropped)", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 5n * 10n ** 18n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const lookupBatch = vi.fn(async () => [
      {
        chainId: "robinhood",
        dexId: "test",
        pairAddress: "0xpairAAA",
        baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
        liquidity: { usd: 5000 },
        marketCap: 9000,
        txns: { h1: { buys: 30, sells: 10 } },
        info: { websites: [{ url: "https://foo.example" }] },
      },
    ]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

    await runUngraduatedFastSweep(deps, Date.now());

    expect(tokenRepo.findByAddress("0xaaa")?.graduated).toBe(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]?.[0]).toBe(deps.telegramChatId);
  });

  it("marks graduated but does not send a live alert when dryRunAlerts is true", async () => {
    const multicall = vi.fn(async () => [{ status: "success", result: [5n * 10n ** 18n, 5n * 10n ** 18n, true] }]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: true,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(Date.now()));

    await runUngraduatedFastSweep(deps, Date.now());

    expect(tokenRepo.findByAddress("0xaaa")?.graduated).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe("runMomentumFastSweep", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  // Defaults satisfy the entry gate (sub-$11k mcap + at least one link) so tests that
  // aren't about the gate keep alerting; gate-specific tests override them.
  function fakePair(
    address: string,
    buys5m: number,
    volume5m: number,
    marketCap: number = 8000,
    info: { websites?: { url: string }[] } = { websites: [{ url: "https://foo.example" }] }
  ) {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: `0xpair-${address}`,
      baseToken: { address, symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      volume: { m5: volume5m },
      txns: { m5: { buys: buys5m }, h1: { buys: 30, sells: 10 } },
      marketCap,
      info,
    };
  }

  it("does nothing when no recently-launched tokens are due", async () => {
    const { deps } = baseDeps(db);
    await runMomentumFastSweep(deps, Date.now());
    expect(deps.dex.lookupBatch).not.toHaveBeenCalled();
  });

  it("sends a momentum alert and marks the one-shot flag when criteria are met", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findByAddress("0xaaa")?.momentum_alert_sent).toBe(1);
  });

  it("does not alert when buys/volume are below the thresholds", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 1, 50)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.momentum_alert_sent).toBe(0);
  });

  it("never fires again once the momentum alert cap is reached", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]);
    const { deps, tokenRepo } = baseDeps(db, { dex: { lookupBatch } as unknown as DexScreenerClient });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    // Original alert plus the one bounded re-alert -> count reaches the cap of 2.
    tokenRepo.incrementMomentumAlertCount("0xaaa");
    tokenRepo.incrementMomentumAlertCount("0xaaa");

    await runMomentumFastSweep(deps, now);

    // Token is excluded from the due list entirely once the cap is reached, so lookupBatch is never called.
    expect(lookupBatch).not.toHaveBeenCalled();
  });

  it("does not alert for a token older than the max-age window", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]);
    const { deps, tokenRepo } = baseDeps(db, { dex: { lookupBatch } as unknown as DexScreenerClient });

    // Well past the max-age window, which is now a week rather than an hour: the momentum
    // detector was repointed from "new pair in its first hour" to "established coin being
    // suddenly bid", so only a genuinely stale coin falls outside it.
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", now - 8 * 24 * 60 * 60 * 1000);

    await runMomentumFastSweep(deps, now);

    // The recency cutoff itself (bounded by earlyMomentumMaxAgeMinutes) excludes it from the due list.
    expect(lookupBatch).not.toHaveBeenCalled();
  });

  it("captures an entry baseline the first time a real alert is sent", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000, 10000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.first_alert_market_cap_usd).toBe(10000);
    expect(token?.first_alert_at).toBe(now);
  });

  it("tracks peak multiple and fires a milestone alert once a configured multiple is crossed", async () => {
    const now = Date.now();
    // Below momentum-alert thresholds -> no new momentum alert fires, isolating the milestone alert.
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 1, 50, 5000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setFirstAlertMarketCap("0xaaa", 1000, now); // baseline already captured

    await runMomentumFastSweep(deps, now); // current mcap 5000 -> 5x -> crosses the 2, 3, and 5 milestones

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.peak_multiple).toBe(5);
    expect(token?.last_milestone_multiple_alerted).toBe(5);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("threads the DexScreener pair's website link into the milestone alert HTML", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 1, 50, 5000, { websites: [{ url: "https://foo.example" }] })]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setFirstAlertMarketCap("0xaaa", 1000, now);

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });

  it("never re-fires an already-crossed milestone", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 1, 50, 5000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setFirstAlertMarketCap("0xaaa", 1000, now);
    tokenRepo.setLastMilestoneMultipleAlerted("0xaaa", 5); // already alerted through 5x

    await runMomentumFastSweep(deps, now); // current mcap still only 5x -> nothing new crossed

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("heals a placeholder symbol/name in-memory so the same-cycle alert never shows a stale '?' (regression)", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]); // fakePair uses real symbol/name "FOO"/"Foo Token"
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    // Token starts tracked with a placeholder identity, as happens when it's first
    // discovered on-chain before DexScreener has indexed it.
    tokenRepo.insertIfNew("0xAAA", "?", "Unknown", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain("· FOO");
    expect(html).not.toContain("· ?");
  });

  it("threads a resolved dev-wallet sold status into the momentum alert", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]);
    const sendAlert = vi.fn(async () => {});
    const readContract = vi.fn(async () => 0n); // deployer holds zero balance -> sold
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      chainClient: { multicall: vi.fn(async () => []), readContract } as unknown as ChainClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", "0xDeployer", "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).not.toContain("dev hold"); // a sold dev is not a risk, so nothing is printed
  });

  // One universal $20k ceiling, per the owner (2026-08-30): the target is lowcaps gaining
  // volume — $3k-$7k especially — and anything above $20k is out of scope for every
  // signal. This replaced a split scheme ($11k entries / $250k breakouts+momentum).
  it("refuses any alert above the universal $20k market-cap ceiling", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000, 21_000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    // Transient block: the alert counter must NOT be consumed, so a later in-window pass can still fire.
    expect(tokenRepo.findByAddress("0xaaa")?.momentum_alert_count).toBe(0);
  });

  it("blocks the momentum alert when a coin has neither links nor enough traction to stand in for them", async () => {
    const now = Date.now();
    // Clears the universal tradability floor, but its 10 buys/hr fall short of the
    // higher bar a link-less coin must clear.
    const noLinksWeakTraction = {
      ...fakePair("0xAAA", 20, 5000, 8000, {}),
      txns: { m5: { buys: 20 }, h1: { buys: 10, sells: 3 } },
    };
    const lookupBatch = vi.fn(async () => [noLinksWeakTraction]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.momentum_alert_count).toBe(0);
  });

  it("blocks a coin with links but near-zero liquidity (the $59-liquidity case)", async () => {
    const now = Date.now();
    const illiquid = {
      ...fakePair("0xAAA", 20, 5000, 7551),
      liquidity: { usd: 59 },
      txns: { m5: { buys: 20 }, h1: { buys: 0, sells: 0 } },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [illiquid]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "GROW", "Grow", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("blocks a coin with links that is drifting on ~1 buy per hour (no live demand)", async () => {
    const now = Date.now();
    const dead = {
      ...fakePair("0xAAA", 20, 5000, 10947),
      liquidity: { usd: 9241 },
      txns: { m5: { buys: 20 }, h1: { buys: 1, sells: 1 } },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [dead]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "DPUNK", "Dpunk", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("alerts a link-less coin that proves itself with real liquidity, buyers and a completed sell", async () => {
    const now = Date.now();
    // No links at all, but genuine traction — the case that was costing real runners.
    const tractionPair = {
      ...fakePair("0xAAA", 20, 5000, 8000, {}),
      liquidity: { usd: 5000 },
      txns: { m5: { buys: 20 }, h1: { buys: 40, sells: 12 } },
    };
    const lookupBatch = vi.fn(async () => [tractionPair]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("still blocks a link-less coin whose traction is too thin to qualify", async () => {
    const now = Date.now();
    const thinPair = {
      ...fakePair("0xAAA", 20, 5000, 8000, {}),
      liquidity: { usd: 400 },
      txns: { m5: { buys: 20 }, h1: { buys: 4, sells: 1 } },
    };
    const lookupBatch = vi.fn(async () => [thinPair]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does not grant the link-less exemption when sell data is unknown (sellability unproven)", async () => {
    const now = Date.now();
    const noSellData = {
      ...fakePair("0xAAA", 20, 5000, 8000, {}),
      liquidity: { usd: 5000 },
      txns: { m5: { buys: 20 }, h1: { buys: 40 } }, // sells absent entirely
    };
    const lookupBatch = vi.fn(async () => [noSellData]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("blocks the momentum alert on the honeypot heuristic (many buys, zero sells in 1h)", async () => {
    const now = Date.now();
    const honeypotPair = {
      ...fakePair("0xAAA", 20, 5000),
      txns: { m5: { buys: 20 }, h1: { buys: 30, sells: 0 } },
    };
    const lookupBatch = vi.fn(async () => [honeypotPair]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("blocks the momentum alert when early-buy (bundle) concentration is above 60%", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 20, 5000)]);
    const sendAlert = vi.fn(async () => {});
    // Top-5 early buyers received 70% of total supply from the pool -> over the 60% line.
    const getLogs = vi.fn(async () => [
      { args: { from: "0xpoolaaa", to: "0xbuyer1", value: 700_000n * 10n ** 18n } },
    ]);
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      chainClient: { multicall: vi.fn(async () => []), getLogs } as unknown as ChainClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew(
      "0xAAA",
      "FOO",
      "Foo Token",
      "0xpairAAA",
      "active",
      null,
      "0xFactory1",
      ALERTABLE_AGE(now),
      "0xPoolAAA",
      null,
      "12345"
    );
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    // Bundle % is fixed at launch (permanent block), so the counter IS consumed to stop re-checks.
    expect(tokenRepo.findByAddress("0xaaa")?.momentum_alert_count).toBe(1);
  });

  it("still fires milestone (10x/100x) alerts for coins above the $11k entry cap (cap applies to entries only)", async () => {
    const now = Date.now();
    // 50,000 mcap: over the entry cap, but 50x the 1,000 baseline -> milestone alert must fire.
    const lookupBatch = vi.fn(async () => [fakePair("0xAAA", 1, 50, 50_000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setFirstAlertMarketCap("0xaaa", 1000, now);

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain("50X SINCE ALERT");
  });
});

describe("handleAlertedToken demotion (revival fizzled)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  function seedAlertedToken(tokenRepo: TokenRepo, snapshotRepo: SnapshotRepo, now: number) {
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    const deadAt = now - 50_000;
    tokenRepo.updateStatus("0xaaa", "dead", deadAt);
    // Dead-period baseline history: healthy-ish figures so a later low-activity poll fails to
    // still look "reviving", and a healthy poll clearly passes the multiple/floor checks.
    snapshotRepo.insert(
      {
        tokenAddress: "0xaaa",
        pairAddress: "0xpairAAA",
        symbol: "FOO",
        name: "Foo Token",
        priceUsd: 0.01,
        marketCapUsd: 5000,
        liquidityUsd: 2000,
        volume5m: 100,
        volume1h: 500,
        volume24h: 1000,
        buys5m: 5,
        buys1h: 20,
        sells5m: 2,
        sells1h: 10,
        imageUrl: null,
        websiteUrl: null,
        socials: [],
      },
      deadAt + 1000
    );
    // markAlerted deliberately preserves status_changed_at (= deadAt), which anchors the
    // dead-period baseline history read above.
    tokenRepo.markAlerted("0xaaa", deadAt + 2000);
    // One poll away from the default demoteConfirmPolls of 3.
    tokenRepo.setDemoteConfirmCount("0xaaa", 2);
  }

  function lowActivityPair() {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 100 },
      volume: { h1: 1 },
      txns: { h1: { buys: 0, sells: 0 } },
    };
  }

  it("demotes back to dead and sends a live demotion alert once revival criteria stop holding for demoteConfirmPolls polls", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [lowActivityPair()]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    seedAlertedToken(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.status).toBe("dead");
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain("REVIVAL FIZZLED");
  });

  it("still demotes but does not send a live alert when dryRunAlerts is true", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [lowActivityPair()]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: true,
    });
    seedAlertedToken(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);

    expect(tokenRepo.findByAddress("0xaaa")?.status).toBe("dead");
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does not demote while revival criteria are still met, and resets demote_confirm_count", async () => {
    const now = Date.now();
    const healthyPair = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 2000 },
      volume: { h1: 5000 },
      txns: { h1: { buys: 20, sells: 5 } },
    };
    const lookupBatch = vi.fn(async () => [healthyPair]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    seedAlertedToken(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.status).toBe("alerted");
    expect(token?.demote_confirm_count).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe("runNonPonsFastSweep (DEX-launched tokens)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  function climbingPair(marketCap: number) {
    return {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "DORK", name: "Dork Lord" },
      liquidity: { usd: 6000 },
      marketCap,
      txns: { m5: { buys: 12, sells: 4 }, h1: { buys: 60, sells: 20 } },
      volume: { m5: 900, h1: 8000 },
      info: {},
    };
  }

  it("fires tier alerts for a DEX-launched coin climbing from its launch floor (the DORK case)", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [climbingPair(5200)]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    // No factory_address => launched straight onto a DEX, not via Pons.
    tokenRepo.insertIfNew("0xAAA", "DORK", "Dork Lord", "0xpairAAA", "active", null, null, ALERTABLE_AGE(now));

    await runNonPonsFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const html = sendAlert.mock.calls[0]?.[1] as string;
    expect(html).toContain("MARKET CAP");
    // This fixture's ladder is [2000,3000,4000,5000,6000], so $5,200 crosses four tiers.
    expect(tokenRepo.findByAddress("0xaaa")?.graduation_alert_tier).toBe(4);
  });

  it("ignores Pons tokens, which the graduation sweep already owns", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [climbingPair(5200)]);
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runNonPonsFastSweep(deps, now);

    expect(lookupBatch).not.toHaveBeenCalled();
  });

  it("still respects the $11k entry cap on these tokens", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [climbingPair(45_000)]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "DORK", "Dork Lord", "0xpairAAA", "active", null, null, ALERTABLE_AGE(now));

    await runNonPonsFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe("on-chain market caps must also be backed by liquidity", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("refuses an all-time high from a pre-index pool with almost no ETH paired in", async () => {
    const now = Date.now();
    const Q96 = 2n ** 96n;
    // A near-empty pool prices the token absurdly high — the source of the $66B highs.
    const sqrtPriceX96 = Q96 * 1000n;
    const multicall = vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
      if (contracts[0]?.functionName === "graduationStatus") {
        // 0.0001 ETH paired: essentially no liquidity behind the price.
        return [{ status: "success", result: [10n ** 14n, 5n * 10n ** 18n, false] }];
      }
      if (contracts[0]?.functionName === "slot0") {
        return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
      }
      return contracts.map(() => ({ status: "failure" }));
    });
    const { deps, tokenRepo } = baseDeps(db, { chainClient: { multicall } as unknown as ChainClient });

    tokenRepo.insertIfNew("0xAAA", "GHOST", "Ghost", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now), "0xPoolAAA", "0xfffPairToken");
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, now);

    expect(tokenRepo.findByAddress("0xaaa")?.ath_market_cap_usd).toBeNull();
  });
});

describe("drained-pool market caps (BINGBONG case)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  /** A real shape observed in production: $66k market cap on $0.02 of liquidity, with the
   * price change reading in the hundreds of millions of percent. */
  function drainedPair(marketCap = 66_194, liquidityUsd = 0.02) {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "BINGBONG", name: "BingBong" },
      liquidity: { usd: liquidityUsd },
      marketCap,
      volume: { m5: 5000, h1: 23_964 },
      txns: { m5: { buys: 20 }, h1: { buys: 28, sells: 1 } },
      info: { websites: [{ url: "https://bing.example" }], socials: [{ url: "https://x.com/b", type: "twitter" }] },
    };
  }

  it("never alerts on a market cap the pool cannot support", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    // Market cap inside the $11k cap, but backed by almost nothing.
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [drainedPair(9000, 0.02)]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    tokenRepo.insertIfNew("0xAAA", "BINGBONG", "BingBong", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.last_block_reason).toBeTruthy();
  });

  it("blocks a milestone alert priced off a drained pool (milestones are cap-exempt)", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    // Cap-exempt path: without the liquidity-backing check, a $66B phantom market cap
    // would fire a "1000X SINCE ALERT" off a pool holding nothing.
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [drainedPair(66_038_071_649, 0.02)]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    tokenRepo.insertIfNew("0xAAA", "BINGBONG", "BingBong", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setFirstAlertMarketCap("0xaaa", 10_490, now);

    await runPollCycle(deps);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.peak_multiple).toBe(0);
  });

  it("refuses to record an all-time high from a drained pool", async () => {
    const now = Date.now();
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [drainedPair(66_038_071_649, 0)]) } as unknown as DexScreenerClient,
    });
    tokenRepo.insertIfNew("0xAAA", "BINGBONG", "BingBong", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runPollCycle(deps);

    // Recording this would poison ATH, peak multiple and the winner/dumper labels.
    expect(tokenRepo.findByAddress("0xaaa")?.ath_market_cap_usd).toBeNull();
  });

  it("still accepts a market cap that real liquidity backs", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    // $9k market cap on $4k liquidity — 44%, comfortably above the 2% floor.
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [drainedPair(9000, 4000)]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    tokenRepo.insertIfNew("0xAAA", "REAL", "Real", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findByAddress("0xaaa")?.ath_market_cap_usd).toBe(9000);
  });
});

describe("quiet-token demotion (keeps the active set worth scanning)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("demotes an active token to unindexed after repeated empty market lookups", async () => {
    const now = Date.now();
    // lookupBatch returns nothing, so no pair comes back for this token.
    const { deps, tokenRepo } = baseDeps(db, { noMarketDataDemoteStreak: 3 });
    tokenRepo.insertIfNew("0xAAA", "GHOST", "Ghost", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runPollCycle(deps);
    expect(tokenRepo.findByAddress("0xaaa")?.status).toBe("active");
    expect(tokenRepo.findByAddress("0xaaa")?.not_indexed_streak).toBe(1);

    await runPollCycle(deps);
    await runPollCycle(deps);

    // Third consecutive miss: it stops consuming the cycle's request budget.
    expect(tokenRepo.findByAddress("0xaaa")?.status).toBe("unindexed");
  });

  it("resets the streak as soon as market data returns", async () => {
    const now = Date.now();
    const pair = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "REAL", name: "Real" },
      liquidity: { usd: 5000 },
      marketCap: 4000,
      txns: { h1: { buys: 20, sells: 8 } },
      info: {},
    };
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [pair]) } as unknown as DexScreenerClient,
    });
    tokenRepo.insertIfNew("0xAAA", "REAL", "Real", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.setNoMarketDataStreak("0xaaa", 2);

    await runPollCycle(deps);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.status).toBe("active");
    expect(token?.not_indexed_streak).toBe(0);
  });

  it("never demotes a dead token, whose status anchors its revival baseline", async () => {
    const now = Date.now();
    const { deps, tokenRepo } = baseDeps(db, { noMarketDataDemoteStreak: 1 });
    tokenRepo.insertIfNew("0xAAA", "DEADC", "Dead Coin", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.updateStatus("0xaaa", "dead", now - 50_000);

    await runPollCycle(deps);
    await runPollCycle(deps);

    expect(tokenRepo.findByAddress("0xaaa")?.status).toBe("dead");
  });
});

describe("breakout detection (any-age surges)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  /** A coin that has been quiet for hours, then rips. */
  function seedQuietThenSurging(tokenRepo: TokenRepo, snapshotRepo: SnapshotRepo, now: number, medianVolume = 200) {
    const bornAt = now - 48 * 3600e3; // two days old: far outside every launch window
    tokenRepo.insertIfNew("0xAAA", "RUNNER", "Runner", "0xpairAAA", "active", null, "0xFactory1", bornAt);
    for (let i = 0; i < 6; i++) {
      snapshotRepo.insert(
        {
          tokenAddress: "0xaaa",
          pairAddress: "0xpairAAA",
          symbol: "RUNNER",
          name: "Runner",
          priceUsd: 0.001,
          marketCapUsd: 2500,
          liquidityUsd: 4000,
          volume5m: 10,
          volume1h: medianVolume,
          volume24h: medianVolume * 20,
          buys5m: 1,
          buys1h: 4,
          sells5m: 1,
          sells1h: 3,
          imageUrl: null,
          websiteUrl: null,
          socials: [],
        },
        bornAt + i * 3600e3
      );
    }
  }

  function surgingPair() {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "RUNNER", name: "Runner" },
      liquidity: { usd: 9000 },
      marketCap: 6000,
      volume: { h1: 9000, h24: 40000 },
      txns: { h1: { buys: 90, sells: 40 } },
      info: { websites: [{ url: "https://runner.example" }] },
    };
  }

  it("alerts a two-day-old coin that surges against its own baseline", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [surgingPair()]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      minAlertConviction: "high",
      dryRunAlerts: false,
    });
    seedQuietThenSurging(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]?.[1]).toContain("BREAKOUT");
    const row = outcomeRepo.findByAddress("0xaaa");
    expect(row?.alert_type).toBe("breakout");
    // Age would rate this "medium"; the breakout rating must survive into the record so
    // /insights measures the signal rather than a contradictory label.
    expect(row?.conviction).toBe("high");
  });

  it("ignores a coin whose volume is merely noisy, not surging", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    // Baseline is already high, so 9k of volume is no longer a 5x move.
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [surgingPair()]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    seedQuietThenSurging(tokenRepo, deps.snapshotRepo, now, 8000);

    await runPollCycle(deps);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("respects its own cooldown and never double-fires", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [surgingPair()]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    seedQuietThenSurging(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);
    await runPollCycle(deps);

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  // The $20k ceiling is universal — a breakout is refused above it exactly like every
  // other signal, per the owner's rule that anything above $20k is out of scope.
  it("refuses a breakout above the universal $20k market-cap ceiling", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const expensive = { ...surgingPair(), marketCap: 22_000 };
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [expensive]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    seedQuietThenSurging(tokenRepo, deps.snapshotRepo, now);

    await runPollCycle(deps);

    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe("focus mode", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("tracks every configured chain when no focus is set", () => {
    const { deps } = baseDeps(db, { enabledChains: ["robinhood", "solana", "bsc"] });
    expect(activeChains(deps)).toEqual(["robinhood", "solana", "bsc"]);
  });

  it("narrows to the focused chain once one is chosen", () => {
    const { deps, settingsRepo } = baseDeps(db, { enabledChains: ["robinhood", "solana", "bsc"] });
    settingsRepo.set(FOCUS_CHAIN_SETTING_KEY, "robinhood", Date.now());
    expect(activeChains(deps)).toEqual(["robinhood"]);
  });

  it("ignores a focus on a chain that isn't enabled, rather than tracking nothing", () => {
    const { deps, settingsRepo } = baseDeps(db, { enabledChains: ["robinhood", "solana"] });
    settingsRepo.set(FOCUS_CHAIN_SETTING_KEY, "hyperevm", Date.now());
    expect(activeChains(deps)).toEqual(["robinhood", "solana"]);
  });

  it("spends the whole scan budget on the focused chain's coins", () => {
    const now = Date.now();
    const { deps, tokenRepo, settingsRepo } = baseDeps(db, { enabledChains: ["robinhood", "solana"] });
    tokenRepo.insertIfNew("0xAAA", "RH", "Rh", "0xp", "active", null, "0xF1", ALERTABLE_AGE(now));
    tokenRepo.insertIfNew("SoLMintAddress111111111111111111111111111", "SOL", "Sol", "p", "active", null, null, now, null, null, null, "solana");

    expect(tokenRepo.listTrackableForCycle(50).length).toBe(2);

    settingsRepo.set(FOCUS_CHAIN_SETTING_KEY, "robinhood", Date.now());
    const focused = tokenRepo.listTrackableForCycle(50, activeChains(deps));
    expect(focused).toHaveLength(1);
    expect(focused[0]?.chain).toBe("robinhood");
  });
});

describe("new-pair targeting and conviction", () => {
  it("rates a brand-new pair on any EVM chain as high conviction", () => {
    for (const chain of ["robinhood", "bsc", "ethereum"]) {
      expect(rateConviction(chain, 2)).toBe("high");
      expect(rateConviction(chain, 45)).toBe("medium");
    }
  });

  it("does not hand a young Solana pair high conviction on age alone", () => {
    // Measured: Solana under 30 min wins 19-26% and dumps 51-60%.
    expect(rateConviction("solana", 2)).toBe("low");
    expect(rateConviction("solana", 2, null)).toBe("low");
  });

  it("promotes a young Solana pair that proves itself: authorities revoked, supply dispersed", () => {
    expect(
      rateConviction("solana", 2, {
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        topHoldersPct: 18,
      })
    ).toBe("high");
  });

  it("refuses that promotion when the coin is bundled or the authorities are live", () => {
    const base = { mintAuthorityActive: false, freezeAuthorityActive: false, topHoldersPct: 18 };
    // Supply concentrated in a few wallets — a bundled launch.
    expect(rateConviction("solana", 2, { ...base, topHoldersPct: 62 })).toBe("low");
    // Freeze authority live — the Solana honeypot vector.
    expect(rateConviction("solana", 2, { ...base, freezeAuthorityActive: true })).toBe("low");
    // Mint authority live — supply can still be printed.
    expect(rateConviction("solana", 2, { ...base, mintAuthorityActive: true })).toBe("low");
    // Concentration unknown — never assumed safe.
    expect(rateConviction("solana", 2, { ...base, topHoldersPct: null })).toBe("low");
  });
});

describe("Solana new-pair conviction is consistent end to end", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("records a promoted Solana new pair as high, matching the verdict that let it through", async () => {
    const now = Date.now();
    const SOL = "Gezgjes2JwgHbQRuRMsZ9EuryJjhStcCgEToEQaXVmEP";
    const safe = { mintAuthorityActive: false, freezeAuthorityActive: false, topHoldersPct: 18, holderCount: 900 };
    const pair = {
      chainId: "solana",
      dexId: "pumpswap",
      pairAddress: "7C19P9fpFSCvvmkSmw767ojHeq9y837vq4LGseBaX1zq",
      baseToken: { address: SOL, symbol: "MOON", name: "Moon" },
      liquidity: { usd: 6000 },
      marketCap: 8000,
      volume: { m5: 5000 },
      txns: { m5: { buys: 20 }, h1: { buys: 40, sells: 15 } },
      info: { websites: [{ url: "https://moon.example" }] },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [pair]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      jupiterClient: { fetchTokenSafety: vi.fn(async () => safe) } as unknown as JupiterClient,
      minAlertConviction: "high",
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew(SOL, "MOON", "Moon", "0xp", "active", null, null, now, null, null, null, "solana");

    await runMomentumFastSweep(deps, now);

    // New pairs are in scope again (MIN_ALERT_AGE_MINUTES is 0), so a clean audit promotes
    // this to "high" and it alerts. The stored rating must match the verdict that let it
    // through, or /insights learns from a label contradicting the decision.
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(outcomeRepo.findByAddress(SOL)?.conviction).toBe("high");
  });

  it("blocks a bundled Solana new pair at the same floor", async () => {
    const now = Date.now();
    const SOL = "Gezgjes2JwgHbQRuRMsZ9EuryJjhStcCgEToEQaXVmEP";
    const bundled = { mintAuthorityActive: false, freezeAuthorityActive: false, topHoldersPct: 71 };
    const pair = {
      chainId: "solana",
      dexId: "pumpswap",
      pairAddress: "7C19",
      baseToken: { address: SOL, symbol: "MOON", name: "Moon" },
      liquidity: { usd: 6000 },
      marketCap: 8000,
      volume: { m5: 5000 },
      txns: { m5: { buys: 20 }, h1: { buys: 40, sells: 15 } },
      info: { websites: [{ url: "https://moon.example" }] },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [pair]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      jupiterClient: { fetchTokenSafety: vi.fn(async () => bundled) } as unknown as JupiterClient,
      minAlertConviction: "high",
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew(SOL, "MOON", "Moon", "0xp", "active", null, null, now, null, null, null, "solana");

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe("revival gate blocking", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("never stamps a cooldown when a revival alert is gate-blocked (regression)", async () => {
    const now = Date.now();
    // Reviving hard, but no links and thin traction -> gate-blocked.
    const blockedPair = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 300 },
      marketCap: 5000,
      volume: { h1: 9000, h24: 20000 },
      txns: { h1: { buys: 30, sells: 8 } },
      info: {},
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [blockedPair]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    const deadAt = now - 50_000;
    tokenRepo.updateStatus("0xaaa", "dead", deadAt);
    deps.snapshotRepo.insert(
      {
        tokenAddress: "0xaaa",
        pairAddress: "0xpairAAA",
        symbol: "FOO",
        name: "Foo Token",
        priceUsd: 0.01,
        marketCapUsd: 5000,
        liquidityUsd: 300,
        volume5m: 1,
        volume1h: 10,
        volume24h: 50,
        buys5m: 0,
        buys1h: 1,
        sells5m: 0,
        sells1h: 0,
        imageUrl: null,
        websiteUrl: null,
        socials: [],
      },
      deadAt + 1000
    );
    tokenRepo.setRevivalConfirmCount("0xaaa", 1); // one more confirm reaches the threshold

    await runPollCycle(deps);

    expect(sendAlert).not.toHaveBeenCalled();
    // The bug: stamping last_alert_at here put the coin in a rolling 6h cooldown that
    // outlived the block and suppressed the alert once it qualified again.
    expect(tokenRepo.findByAddress("0xaaa")?.last_alert_at).toBeNull();
  });
});

describe("observer (alert outcomes + missed winners)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  function gatePassingPair(address: string, marketCap: number) {
    return {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: `0xpair-${address}`,
      baseToken: { address, symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      volume: { m5: 5000 },
      txns: { m5: { buys: 20 }, h1: { buys: 30, sells: 10 } },
      marketCap,
      info: { websites: [{ url: "https://foo.example" }] },
    };
  }

  it("records an outcome entry with the coin's entry features when a momentum alert sends", async () => {
    const now = Date.now();
    const lookupBatch = vi.fn(async () => [gatePassingPair("0xAAA", 8000)]);
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      dex: { lookupBatch } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));

    await runMomentumFastSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const row = outcomeRepo.findByAddress("0xaaa");
    expect(row?.alert_type).toBe("momentum");
    expect(row?.entry_market_cap_usd).toBe(8000);
    expect(row?.had_website).toBe(1);
    expect(row?.outcome).toBe("pending");
  });

  it("fills due checkpoints and classifies a coin that halved as a dumper", async () => {
    const now = Date.now();
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [gatePassingPair("0xAAA", 3000)]) } as unknown as DexScreenerClient,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "alerted", null, "0xFactory1", now - 26 * 3600e3);
    outcomeRepo.recordEntry({
      address: "0xaaa",
      firstAlertedAt: now - 25 * 3600e3,
      alertType: "momentum",
      entryMarketCapUsd: 10_000,
      bundleTop5Pct: 30,
      holderTop10Pct: 40,
      devSold: 0,
      hadWebsite: true,
      socialCount: 1,
    });

    await runObserverSweep(deps, now);

    const row = outcomeRepo.findByAddress("0xaaa");
    expect(row?.mcap_1h_usd).toBe(3000);
    expect(row?.mcap_6h_usd).toBe(3000);
    expect(row?.mcap_24h_usd).toBe(3000);
    expect(row?.outcome).toBe("dumper");
  });

  it("classifies a coin as a winner from its peak multiple regardless of later dumps", async () => {
    const now = Date.now();
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [gatePassingPair("0xAAA", 1000)]) } as unknown as DexScreenerClient,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "alerted", null, "0xFactory1", now - 26 * 3600e3);
    tokenRepo.setFirstAlertMarketCap("0xaaa", 5000, now - 25 * 3600e3);
    tokenRepo.updatePeakMultiple("0xaaa", 3, now - 10 * 3600e3); // peaked at 3x before dumping
    outcomeRepo.recordEntry({
      address: "0xaaa",
      firstAlertedAt: now - 25 * 3600e3,
      alertType: "revival",
      entryMarketCapUsd: 5000,
      bundleTop5Pct: null,
      holderTop10Pct: null,
      devSold: null,
      hadWebsite: true,
      socialCount: 0,
    });

    await runObserverSweep(deps, now);

    expect(outcomeRepo.findByAddress("0xaaa")?.outcome).toBe("winner");
  });

  it("records never-alerted coins with a high ATH as missed winners, with the gate reason", async () => {
    const now = Date.now();
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db);

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.updateAthMarketCap("0xaaa", 40_000);
    tokenRepo.setLastBlockReason("0xaaa", "no website or social links");

    await runObserverSweep(deps, now);

    const missed = outcomeRepo.listMissedWinners(10);
    expect(missed).toHaveLength(1);
    expect(missed[0]?.ath_market_cap_usd).toBe(40_000);
    expect(missed[0]?.block_reason).toBe("no website or social links");
  });

  it("does not flag alerted coins as missed winners", async () => {
    const now = Date.now();
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db);

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now));
    tokenRepo.updateAthMarketCap("0xaaa", 40_000);
    tokenRepo.markAlerted("0xaaa", now); // it WAS alerted

    await runObserverSweep(deps, now);

    expect(outcomeRepo.countMissedWinners()).toBe(0);
  });

  it("throttles the gate's snapshot lookup for a token blocked moments ago (protects the request budget)", async () => {
    const now = Date.now();
    const multicall = vi.fn(async () => [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }]);
    const Q96 = 2n ** 96n;
    const sqrtPriceX96 = Q96 / 1000n;
    const chainClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
        if (contracts[0]?.functionName === "graduationStatus") return multicall();
        if (contracts[0]?.functionName === "slot0") {
          return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
        }
        return contracts.map(() => ({ status: "failure" }));
      }),
    } as unknown as ChainClient;
    // No links, no traction -> always blocked.
    const blocked = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 100 },
      marketCap: 3500,
      txns: { h1: { buys: 0, sells: 0 } },
      info: {},
    };
    const lookupBatch = vi.fn(async () => [blocked]);
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient,
      dex: { lookupBatch } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now), "0xPoolAAA", "0xfffPairToken");
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, now);
    const afterFirst = lookupBatch.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Immediately re-running must NOT spend another gate lookup on the same token.
    await runUngraduatedFastSweep(deps, now + 1000);
    expect(lookupBatch.mock.calls.length).toBe(afterFirst);
  });

  it("does not consume the tier index when a tier alert is blocked for a transient reason (regression)", async () => {
    const now = Date.now();
    const multicall = vi.fn(async () => [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }]);
    const sendAlert = vi.fn(async () => {});
    // Pair has a qualifying market cap but NO links -> transient block.
    const noLinks = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      marketCap: 3500,
      info: {},
    };
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      chainClient: { multicall } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch: vi.fn(async () => [noLinks]) } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now), "0xPoolAAA", "0xfffPairToken");
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    const token = tokenRepo.findByAddress("0xaaa");
    // Tier NOT consumed: the coin can still get this alert once links are indexed.
    expect(token?.graduation_alert_tier).toBe(0);
    // And no entry baseline captured, so gate-exempt milestone alerts can't fire for a
    // coin the owner was never alerted about.
    expect(token?.first_alert_market_cap_usd).toBeNull();
    expect(outcomeRepo.findByAddress("0xaaa")).toBeUndefined();
  });

  // The tighter new-pair bundle cap is now unreachable in practice: a pair young enough to
  // qualify for it is already below the minimum alert age, so the age floor rejects it
  // first. Kept as a regression guard that a bundled brand-new launch never alerts, which
  // is what the cap existed to guarantee.
  it("never alerts a bundled brand-new pair (age floor now rejects it before the bundle cap)", async () => {
    const now = Date.now();
    const Q96 = 2n ** 96n;
    const sqrtPriceX96 = Q96 / 1000n;
    const chainClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
        if (contracts[0]?.functionName === "graduationStatus") {
          return [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }];
        }
        if (contracts[0]?.functionName === "slot0") {
          return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
        }
        return contracts.map(() => ({ status: "failure" }));
      }),
      // Top-5 early buyers hold 55%: under the standard 60% cap, over the new-pair 50% one.
      getLogs: vi.fn(async () => [{ args: { from: "0xpoolaaa", to: "0xbuyer1", value: 550_000n * 10n ** 18n } }]),
    } as unknown as ChainClient;
    const pair = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      marketCap: 3500,
      txns: { h1: { buys: 30, sells: 10 } },
      info: { websites: [{ url: "https://foo.example" }] },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch: vi.fn(async () => [pair]) } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    // first_seen_at = now -> a brand-new pair.
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", now, "0xPoolAAA", "0xfffPairToken", "12345");
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does consume the tier index when blocked by the permanent bundle cap (avoids re-checking forever)", async () => {
    const now = Date.now();
    const Q96 = 2n ** 96n;
    const sqrtPriceX96 = Q96 / 1000n;
    const multicall = vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) => {
      if (contracts[0]?.functionName === "graduationStatus") {
        return [{ status: "success", result: [1n * 10n ** 18n, 5n * 10n ** 18n, false] }];
      }
      if (contracts[0]?.functionName === "slot0") {
        return contracts.map(() => ({ status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }));
      }
      return contracts.map(() => ({ status: "failure" }));
    });
    // Top-5 early buyers hold 70% of supply -> over the 60% cap (permanent).
    const getLogs = vi.fn(async () => [{ args: { from: "0xpoolaaa", to: "0xbuyer1", value: 700_000n * 10n ** 18n } }]);
    const withLinks = {
      chainId: "robinhood",
      dexId: "test",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FOO", name: "Foo Token" },
      liquidity: { usd: 5000 },
      marketCap: 3500,
      txns: { h1: { buys: 30, sells: 10 } },
      info: { websites: [{ url: "https://foo.example" }] },
    };
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo } = baseDeps(db, {
      chainClient: { multicall, getLogs } as unknown as ChainClient,
      notifier: { sendAlert } as unknown as Notifier,
      dex: { lookupBatch: vi.fn(async () => [withLinks]) } as unknown as DexScreenerClient,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", ALERTABLE_AGE(now), "0xPoolAAA", "0xfffPairToken", "12345");
    tokenRepo.setTokenDecimalsAndSupply("0xaaa", 18, (1_000_000n * 10n ** 18n).toString());

    await runUngraduatedFastSweep(deps, now);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(tokenRepo.findByAddress("0xaaa")?.graduation_alert_tier).toBeGreaterThan(0);
  });

  it("auto-tightens the bundle cap and notifies the owner once real outcomes justify it, and never loosens it", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo, outcomeRepo, settingsRepo } = baseDeps(db, {
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    // 5 winners averaging 20% bundle, 5 dumpers averaging 50% — a real, wide gap.
    for (let i = 0; i < 5; i++) {
      const winnerAddr = `0x00000000000000000000000000000000000000a${i}`;
      tokenRepo.insertIfNew(winnerAddr, "WIN", "Winner", "0xp", "active", null, "0xF1", ALERTABLE_AGE(now));
      outcomeRepo.recordEntry({
        address: winnerAddr,
        firstAlertedAt: now,
        alertType: "momentum",
        entryMarketCapUsd: 5000,
        bundleTop5Pct: 20,
        holderTop10Pct: null,
        devSold: null,
        hadWebsite: true,
        socialCount: 1,
      });
      outcomeRepo.applyCheckpoints(winnerAddr, {}, "winner", now);

      const dumperAddr = `0x00000000000000000000000000000000000000b${i}`;
      tokenRepo.insertIfNew(dumperAddr, "DMP", "Dumper", "0xp", "active", null, "0xF1", ALERTABLE_AGE(now));
      outcomeRepo.recordEntry({
        address: dumperAddr,
        firstAlertedAt: now,
        alertType: "momentum",
        entryMarketCapUsd: 5000,
        bundleTop5Pct: 50,
        holderTop10Pct: null,
        devSold: null,
        hadWebsite: true,
        socialCount: 1,
      });
      outcomeRepo.applyCheckpoints(dumperAddr, {}, "dumper", now);
    }

    await runObserverSweep(deps, now);

    // Midpoint of 20% and 50% = 35% (also the hard floor).
    expect(effectiveBundleCapPct(settingsRepo)).toBe(35);
    expect(settingsRepo.get(BUNDLE_CAP_SETTING_KEY)).toBe("35");
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]?.[1]).toContain("AUTO-TUNE APPLIED");

    // A second sweep with the same data must not re-tune or re-notify.
    await runObserverSweep(deps, now + 1000);
    expect(effectiveBundleCapPct(settingsRepo)).toBe(35);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("refuses to auto-tune when the proposed cap would remove more winners than dumpers", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const { deps, tokenRepo, outcomeRepo, settingsRepo } = baseDeps(db, {
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    // Averages suggest a gap (winners 20%, dumpers 46%), but the winners' distribution is
    // bimodal: most sit low, several sit very high. The midpoint cap therefore cuts more
    // winners than dumpers — exactly the trap that killed the holder-concentration gate.
    const winnerBundles = [5, 5, 5, 95, 95, 95, 95];
    const dumperBundles = [5, 5, 45, 95, 95];
    let n = 0;
    const seed = (bundle: number, outcome: string) => {
      const addr = `0x${(++n).toString(16).padStart(40, "0")}`;
      tokenRepo.insertIfNew(addr, "T", "T", "0xp", "active", null, "0xF1", ALERTABLE_AGE(now));
      outcomeRepo.recordEntry({
        address: addr,
        firstAlertedAt: now,
        alertType: "momentum",
        entryMarketCapUsd: 5000,
        bundleTop5Pct: bundle,
        holderTop10Pct: null,
        devSold: null,
        hadWebsite: true,
        socialCount: 1,
      });
      outcomeRepo.applyCheckpoints(addr, {}, outcome, now);
    };
    for (const b of winnerBundles) seed(b, "winner");
    for (const b of dumperBundles) seed(b, "dumper");

    await runObserverSweep(deps, now);

    // Cap left untouched, and the owner is not told a change happened.
    expect(effectiveBundleCapPct(settingsRepo)).toBe(60);
    expect(settingsRepo.get(BUNDLE_CAP_SETTING_KEY)).toBeUndefined();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("sends a one-time LIQUIDITY GONE warning when an alerted coin's pair vanishes", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    // Default dex mock returns [] -> no pair -> observed mcap 0 (liquidity pulled).
    const { deps, tokenRepo, outcomeRepo } = baseDeps(db, {
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });

    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "alerted", null, "0xFactory1", now - 3 * 3600e3);
    outcomeRepo.recordEntry({
      address: "0xaaa",
      firstAlertedAt: now - 2 * 3600e3,
      alertType: "momentum",
      entryMarketCapUsd: 10_000,
      bundleTop5Pct: null,
      holderTop10Pct: null,
      devSold: null,
      hadWebsite: true,
      socialCount: 0,
    });

    await runObserverSweep(deps, now);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]?.[1]).toContain("LIQUIDITY GONE");
    expect(outcomeRepo.findByAddress("0xaaa")?.warning_sent).toBe(1);

    // Never re-fires.
    await runObserverSweep(deps, now + 1000);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});

describe("reversal reaches coins resting on their floor", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  // Both bugs this covers made the reversal signal unreachable in production: the handler
  // required status 'active' (a coin on its floor is 'dead'), and it screened candidates at
  // the full breakout volume floors before the lower reversal floors were ever applied.
  it("alerts a dead coin whose price has turned up off its floor on modest volume", async () => {
    const now = Date.now();
    const sendAlert = vi.fn(async () => {});
    const pair = {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0xpairAAA",
      baseToken: { address: "0xAAA", symbol: "FLOOR", name: "Floor" },
      liquidity: { usd: 4000 },
      marketCap: 9000,
      priceUsd: "0.0015",
      volume: { h1: 1600, h24: 6000 },
      txns: { h1: { buys: 16, sells: 4 } },
      info: { websites: [{ url: "https://floor.example" }] },
    };
    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [pair]) } as unknown as DexScreenerClient,
      notifier: { sendAlert } as unknown as Notifier,
      dryRunAlerts: false,
    });
    const snapshotRepo = deps.snapshotRepo;

    tokenRepo.insertIfNew("0xAAA", "FLOOR", "Floor", "0xpairAAA", "dead", null, "0xFactory1", ALERTABLE_AGE(now));
    // A flat history sitting at the floor price of 0.001; current 0.0015 is a 1.5x recovery.
    for (let i = 5; i > 0; i -= 1) {
      snapshotRepo.insert(
        {
          tokenAddress: "0xAAA", symbol: "FLOOR", name: "Floor", priceUsd: 0.001, marketCapUsd: 6000,
          liquidityUsd: 4000, volume5m: 0, volume1h: 300, volume24h: 3000, buys5m: 0, buys1h: 4,
          sells1h: 2, imageUrl: null, websiteUrl: null, socials: [], dexUrl: "", pairCreatedAt: null,
        },
        now - i * 600000
      );
    }

    await runPollCycle(deps);

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});
