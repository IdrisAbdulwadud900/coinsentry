import { describe, expect, it } from "vitest";
import {
  evaluatePercentMove,
  evaluateThreshold,
  evaluateTrend,
} from "../src/engine/ruleEvaluator.js";
import type {
  MarketSnapshot,
  PercentMoveConfig,
  SnapshotRow,
  ThresholdConfig,
  TrendConfig,
} from "../src/types/domain.js";

function makeMarket(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "pair123",
    tokenAddress: "token123",
    symbol: "TEST",
    name: "Test Token",
    pairUrl: "https://dexscreener.com/solana/pair123",
    priceUsd: 1,
    mcap: 10_000,
    liquidityUsd: 8_000,
    volumeM5: 1000,
    volumeH1: 5000,
    volumeH24: 50000,
    priceChangeM5: 0,
    priceChangeH1: 0,
    priceChangeH6: 0,
    priceChangeH24: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 1,
    token_id: 1,
    ts: Date.now(),
    price_usd: 1,
    mcap: 10_000,
    liquidity_usd: 8_000,
    volume_m5: 1000,
    volume_h1: 5000,
    volume_h24: 50000,
    price_change_m5: 0,
    price_change_h1: 0,
    price_change_h6: 0,
    price_change_h24: 0,
    ...overrides,
  };
}

describe("evaluateThreshold", () => {
  const baseConfig: ThresholdConfig = {
    kind: "threshold",
    metric: "mcap",
    condition: "below",
    value: 5000,
    mode: "one_shot",
    hysteresisPct: 3,
  };

  it("fires when mcap drops to or below the target while armed", () => {
    const market = makeMarket({ mcap: 4900 });
    const result = evaluateThreshold(baseConfig, market, true);
    expect(result.fired).toBe(true);
    expect(result.newArmed).toBe(false);
  });

  it("does not fire when mcap is still above the target", () => {
    const market = makeMarket({ mcap: 5500 });
    const result = evaluateThreshold(baseConfig, market, true);
    expect(result.fired).toBe(false);
    expect(result.newArmed).toBe(true);
  });

  it("marks one-shot rules for deactivation after firing", () => {
    const market = makeMarket({ mcap: 4900 });
    const result = evaluateThreshold(baseConfig, market, true);
    expect(result.shouldDeactivate).toBe(true);
  });

  it("does not deactivate repeating rules after firing", () => {
    const repeating: ThresholdConfig = { ...baseConfig, mode: "repeating" };
    const market = makeMarket({ mcap: 4900 });
    const result = evaluateThreshold(repeating, market, true);
    expect(result.shouldDeactivate).toBe(false);
    expect(result.newArmed).toBe(false);
  });

  it("does not re-fire while disarmed until price recovers past the hysteresis band", () => {
    const repeating: ThresholdConfig = { ...baseConfig, mode: "repeating" };
    // Still below target, disarmed: should not fire and should stay disarmed.
    const stillLow = evaluateThreshold(repeating, makeMarket({ mcap: 4950 }), false);
    expect(stillLow.fired).toBe(false);
    expect(stillLow.newArmed).toBe(false);

    // Recovers just above target but within hysteresis band (5000 * 1.03 = 5150): still disarmed.
    const withinBand = evaluateThreshold(repeating, makeMarket({ mcap: 5100 }), false);
    expect(withinBand.newArmed).toBe(false);

    // Recovers past hysteresis band: rearms.
    const pastBand = evaluateThreshold(repeating, makeMarket({ mcap: 5200 }), false);
    expect(pastBand.fired).toBe(false);
    expect(pastBand.newArmed).toBe(true);
  });

  it("handles the 'above' condition symmetrically", () => {
    const above: ThresholdConfig = { ...baseConfig, condition: "above", value: 20_000 };
    const fires = evaluateThreshold(above, makeMarket({ mcap: 21_000 }), true);
    expect(fires.fired).toBe(true);

    const doesNotFire = evaluateThreshold(above, makeMarket({ mcap: 15_000 }), true);
    expect(doesNotFire.fired).toBe(false);
  });

  it("does not fire when the configured metric is null", () => {
    const liqConfig: ThresholdConfig = { ...baseConfig, metric: "liquidity", value: 1000 };
    const result = evaluateThreshold(liqConfig, makeMarket({ liquidityUsd: null }), true);
    expect(result.fired).toBe(false);
  });
});

describe("evaluatePercentMove", () => {
  const config: PercentMoveConfig = {
    kind: "percent_move",
    basePrice: 1,
    percent: 10,
    mode: "repeating",
    hysteresisPct: 2,
  };

  it("fires when price rises past the percent threshold", () => {
    const result = evaluatePercentMove(config, makeMarket({ priceUsd: 1.15 }), true);
    expect(result.fired).toBe(true);
  });

  it("fires when price drops past the percent threshold", () => {
    const result = evaluatePercentMove(config, makeMarket({ priceUsd: 0.85 }), true);
    expect(result.fired).toBe(true);
  });

  it("does not fire within the threshold band", () => {
    const result = evaluatePercentMove(config, makeMarket({ priceUsd: 1.05 }), true);
    expect(result.fired).toBe(false);
  });

  it("rearms only once price returns within the hysteresis band", () => {
    const stillFar = evaluatePercentMove(config, makeMarket({ priceUsd: 1.15 }), false);
    expect(stillFar.newArmed).toBe(false);

    const backNearBase = evaluatePercentMove(config, makeMarket({ priceUsd: 1.01 }), false);
    expect(backNearBase.newArmed).toBe(true);
  });
});

describe("evaluateTrend", () => {
  const upConfig: TrendConfig = {
    kind: "trend",
    direction: "up",
    m5ChangePct: 4,
    h1ChangePct: 0,
    volumeMultiplier: 1.5,
    consecutivePolls: 3,
    cooldownMinutes: 30,
  };

  function risingHistory(): SnapshotRow[] {
    return [
      makeSnapshot({ price_usd: 0.9, volume_m5: 500 }),
      makeSnapshot({ price_usd: 0.95, volume_m5: 500 }),
    ];
  }

  it("fires when all uptrend conditions are met", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: 1, volumeM5: 2000 });
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(true);
  });

  it("does not fire if m5 change is too small", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 1, priceChangeH1: 1, volumeM5: 2000 });
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire if h1 is fighting a bigger downtrend", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: -5, volumeM5: 2000 });
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire without a volume spike", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: 1, volumeM5: 600 });
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire without consecutive rising polls", () => {
    const fallingHistory = [
      makeSnapshot({ price_usd: 1.1, volume_m5: 500 }),
      makeSnapshot({ price_usd: 0.95, volume_m5: 500 }),
    ];
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: 1, volumeM5: 2000 });
    const result = evaluateTrend(upConfig, {
      market,
      history: fallingHistory,
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(false);
  });

  it("respects the cooldown window after firing", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: 1, volumeM5: 2000 });
    const recentlyFired = Date.now() - 5 * 60_000; // 5 minutes ago, cooldown is 30
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: recentlyFired,
      now: Date.now(),
    });
    expect(result.fired).toBe(false);
  });

  it("fires again once the cooldown has elapsed", () => {
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: 5, priceChangeH1: 1, volumeM5: 2000 });
    const longAgo = Date.now() - 31 * 60_000;
    const result = evaluateTrend(upConfig, {
      market,
      history: risingHistory(),
      lastFiredAt: longAgo,
      now: Date.now(),
    });
    expect(result.fired).toBe(true);
  });

  it("mirrors logic for downtrend detection", () => {
    const downConfig: TrendConfig = { ...upConfig, direction: "down" };
    const fallingHistory = [
      makeSnapshot({ price_usd: 1.1, volume_m5: 500 }),
      makeSnapshot({ price_usd: 1.05, volume_m5: 500 }),
    ];
    const market = makeMarket({ priceUsd: 1.0, priceChangeM5: -5, priceChangeH1: -1, volumeM5: 2000 });
    const result = evaluateTrend(downConfig, {
      market,
      history: fallingHistory,
      lastFiredAt: null,
      now: Date.now(),
    });
    expect(result.fired).toBe(true);
  });
});
