import { describe, it, expect } from "vitest";
import {
  median,
  ageHours,
  meetsDeadCriteria,
  computeBaseline,
  meetsRevivalCriteria,
  isInCooldown,
  meetsEarlyMomentumCriteria,
  meetsMomentumReAlertCriteria,
  CLASSIFIER_CONFIG_KEYS,
  buildClassifierConfig,
  type ClassifierConfig,
  type MomentumConfig,
  type MomentumReAlertConfig,
} from "../src/engine/classifier.js";

const config: ClassifierConfig = {
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

describe("median", () => {
  it("returns 0 for empty array", () => {
    expect(median([])).toBe(0);
  });
  it("computes median of odd-length array", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("computes median of even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("ageHours", () => {
  it("computes elapsed hours", () => {
    const first = 0;
    const now = 1000 * 60 * 60 * 25; // 25 hours later
    expect(ageHours(now, first)).toBeCloseTo(25);
  });
});

describe("meetsDeadCriteria", () => {
  it("is false for tokens younger than the min age gate, even with zero volume", () => {
    const result = meetsDeadCriteria(config, 10, { volume24h: 0, volume1h: 0, buys1h: 0, liquidityUsd: 100 });
    expect(result).toBe(false);
  });

  it("is true once age, volume, and buys all fall below thresholds", () => {
    const result = meetsDeadCriteria(config, 48, { volume24h: 10, volume1h: 0, buys1h: 0, liquidityUsd: 100 });
    expect(result).toBe(true);
  });

  it("is false if volume_24h is still at/above threshold", () => {
    const result = meetsDeadCriteria(config, 48, { volume24h: 500, volume1h: 0, buys1h: 0, liquidityUsd: 100 });
    expect(result).toBe(false);
  });

  it("is false if buys_1h is still at/above threshold", () => {
    const result = meetsDeadCriteria(config, 48, { volume24h: 10, volume1h: 0, buys1h: 3, liquidityUsd: 100 });
    expect(result).toBe(false);
  });
});

describe("computeBaseline", () => {
  it("computes median volume and liquidity from history", () => {
    const history = [
      { volume_1h: 10, liquidity_usd: 1000 },
      { volume_1h: 20, liquidity_usd: 1200 },
      { volume_1h: 0, liquidity_usd: 900 },
    ];
    const baseline = computeBaseline(history);
    expect(baseline.medianVolume1h).toBe(10);
    expect(baseline.medianLiquidityUsd).toBe(1000);
    expect(baseline.sampleSize).toBe(3);
  });

  it("treats null fields as 0", () => {
    const baseline = computeBaseline([{ volume_1h: null, liquidity_usd: null }]);
    expect(baseline.medianVolume1h).toBe(0);
    expect(baseline.medianLiquidityUsd).toBe(0);
  });
});

describe("meetsRevivalCriteria", () => {
  const baseline = { medianVolume1h: 50, medianLiquidityUsd: 1000, sampleSize: 8 };

  it("fires when all four conditions are met", () => {
    const current = { volume24h: null, volume1h: 500, buys1h: 10, liquidityUsd: 900 };
    expect(meetsRevivalCriteria(config, current, baseline)).toBe(true);
  });

  it("blocks when volume multiple is not met even if absolute volume looks high", () => {
    // baseline median is 50, so 8x = 400; 350 is above the $300 floor but below the 8x multiple
    const current = { volume24h: null, volume1h: 350, buys1h: 10, liquidityUsd: 900 };
    expect(meetsRevivalCriteria(config, current, baseline)).toBe(false);
  });

  it("blocks a near-zero-baseline false trigger via the absolute $ floor", () => {
    const nearZeroBaseline = { medianVolume1h: 1, medianLiquidityUsd: 1000, sampleSize: 8 };
    // 8x of $1 is $8 -- trivially passed by noise, but the $300 floor should block it
    const current = { volume24h: null, volume1h: 50, buys1h: 10, liquidityUsd: 900 };
    expect(meetsRevivalCriteria(config, current, nearZeroBaseline)).toBe(false);
  });

  it("blocks when buy count is too low", () => {
    const current = { volume24h: null, volume1h: 500, buys1h: 4, liquidityUsd: 900 };
    expect(meetsRevivalCriteria(config, current, baseline)).toBe(false);
  });

  it("blocks when liquidity has collapsed (rug/wash-trade guard)", () => {
    const current = { volume24h: null, volume1h: 500, buys1h: 10, liquidityUsd: 700 }; // 70% of 1000, floor is 80%
    expect(meetsRevivalCriteria(config, current, baseline)).toBe(false);
  });
});

describe("isInCooldown", () => {
  it("is false when never alerted", () => {
    expect(isInCooldown(null, Date.now(), 6)).toBe(false);
  });

  it("is true within the cooldown window", () => {
    const now = 1000 * 60 * 60 * 100;
    const lastAlert = now - 1000 * 60 * 60 * 2; // 2 hours ago, cooldown is 6h
    expect(isInCooldown(lastAlert, now, 6)).toBe(true);
  });

  it("is false once the cooldown window has passed", () => {
    const now = 1000 * 60 * 60 * 100;
    const lastAlert = now - 1000 * 60 * 60 * 7; // 7 hours ago, cooldown is 6h
    expect(isInCooldown(lastAlert, now, 6)).toBe(false);
  });
});

describe("meetsEarlyMomentumCriteria", () => {
  const momentumConfig: MomentumConfig = {
    earlyMomentumMaxAgeMinutes: 60,
    earlyMomentumMinBuys5m: 10,
    earlyMomentumMinVolume5mUsd: 1000,
  };

  it("fires when age, buys, and volume all meet the thresholds", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 30, { buys5m: 10, volume5m: 1000 })).toBe(true);
  });

  it("is false once the token is older than the max age window", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 61, { buys5m: 50, volume5m: 5000 })).toBe(false);
  });

  it("is true exactly at the max age boundary", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 60, { buys5m: 10, volume5m: 1000 })).toBe(true);
  });

  it("is false when buys_5m is below the minimum", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 10, { buys5m: 9, volume5m: 5000 })).toBe(false);
  });

  it("is false when volume_5m is below the minimum", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 10, { buys5m: 50, volume5m: 999 })).toBe(false);
  });

  it("treats null buys/volume as 0", () => {
    expect(meetsEarlyMomentumCriteria(momentumConfig, 10, { buys5m: null, volume5m: null })).toBe(false);
  });
});

describe("meetsMomentumReAlertCriteria", () => {
  const reAlertConfig: MomentumReAlertConfig = {
    earlyMomentumMaxAgeMinutes: 60,
    earlyMomentumMinBuys5m: 10,
    earlyMomentumMinVolume5mUsd: 1000,
    momentumRealertMultiple: 3,
  };

  it("fires when buys/volume have grown to at least the re-alert multiple of the original thresholds", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 30, { buys5m: 30, volume5m: 3000 })).toBe(true);
  });

  it("is false when buys_5m has grown but is still below the multiplied threshold", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 30, { buys5m: 29, volume5m: 5000 })).toBe(false);
  });

  it("is false when volume_5m has grown but is still below the multiplied threshold", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 30, { buys5m: 50, volume5m: 2999 })).toBe(false);
  });

  it("is false once the token is older than the max age window", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 61, { buys5m: 100, volume5m: 10000 })).toBe(false);
  });

  it("is false at the original (non-multiplied) one-shot thresholds", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 30, { buys5m: 10, volume5m: 1000 })).toBe(false);
  });

  it("treats null buys/volume as 0", () => {
    expect(meetsMomentumReAlertCriteria(reAlertConfig, 10, { buys5m: null, volume5m: null })).toBe(false);
  });
});

describe("CLASSIFIER_CONFIG_KEYS", () => {
  it("covers exactly the ClassifierConfig fields, with no duplicates", () => {
    expect(CLASSIFIER_CONFIG_KEYS).toHaveLength(11);
    expect(new Set(CLASSIFIER_CONFIG_KEYS).size).toBe(CLASSIFIER_CONFIG_KEYS.length);
    for (const key of CLASSIFIER_CONFIG_KEYS) {
      expect(config).toHaveProperty(key);
    }
  });
});

describe("buildClassifierConfig", () => {
  it("falls back to the default for a field with no stored override", () => {
    const live = buildClassifierConfig(config, { get: () => undefined });
    expect(live.deadMinAgeHours).toBe(config.deadMinAgeHours);
    expect(live.alertCooldownHours).toBe(config.alertCooldownHours);
  });

  it("uses the stored override, parsed as a number, when present", () => {
    const store = new Map([["deadMinAgeHours", "48"]]);
    const live = buildClassifierConfig(config, { get: (key) => store.get(key) });
    expect(live.deadMinAgeHours).toBe(48);
    expect(live.deadVolume24hUsd).toBe(config.deadVolume24hUsd);
  });

  it("falls back to the default if the stored override is not a finite number", () => {
    const live = buildClassifierConfig(config, { get: () => "not-a-number" });
    expect(live.deadMinAgeHours).toBe(config.deadMinAgeHours);
  });

  it("reads live -- a later override change is reflected without rebuilding the config object", () => {
    const store = new Map<string, string>();
    const live = buildClassifierConfig(config, { get: (key) => store.get(key) });
    expect(live.revivalConfirmPolls).toBe(config.revivalConfirmPolls);
    store.set("revivalConfirmPolls", "5");
    expect(live.revivalConfirmPolls).toBe(5);
  });
});
