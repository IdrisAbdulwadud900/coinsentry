import type {
  MarketSnapshot,
  PercentMoveConfig,
  RuleConfig,
  SnapshotRow,
  ThresholdConfig,
  TrendConfig,
} from "../types/domain.js";

export interface EvaluationOutcome {
  fired: boolean;
  /** New value the rule's `armed` column should be set to. Irrelevant for trend rules. */
  newArmed: boolean;
  /** True when a one-shot rule just fired and should be paused (active = 0) by the caller. */
  shouldDeactivate: boolean;
}

const NOT_FIRED = (armed: boolean): EvaluationOutcome => ({
  fired: false,
  newArmed: armed,
  shouldDeactivate: false,
});

function metricValue(metric: ThresholdConfig["metric"], market: MarketSnapshot): number | null {
  switch (metric) {
    case "price":
      return market.priceUsd;
    case "mcap":
      return market.mcap;
    case "liquidity":
      return market.liquidityUsd;
  }
}

export function evaluateThreshold(
  config: ThresholdConfig,
  market: MarketSnapshot,
  armed: boolean
): EvaluationOutcome {
  const value = metricValue(config.metric, market);
  if (value === null) return NOT_FIRED(armed);

  const hysteresis = config.hysteresisPct / 100;

  if (config.condition === "below") {
    const rearmLevel = config.value * (1 + hysteresis);
    if (armed) {
      if (value <= config.value) {
        return { fired: true, newArmed: false, shouldDeactivate: config.mode === "one_shot" };
      }
      return NOT_FIRED(true);
    }
    // Disarmed, waiting to rearm once price recovers above the hysteresis band.
    if (value > rearmLevel) return NOT_FIRED(true);
    return NOT_FIRED(false);
  }

  // condition === "above"
  const rearmLevel = config.value * (1 - hysteresis);
  if (armed) {
    if (value >= config.value) {
      return { fired: true, newArmed: false, shouldDeactivate: config.mode === "one_shot" };
    }
    return NOT_FIRED(true);
  }
  if (value < rearmLevel) return NOT_FIRED(true);
  return NOT_FIRED(false);
}

export function evaluatePercentMove(
  config: PercentMoveConfig,
  market: MarketSnapshot,
  armed: boolean
): EvaluationOutcome {
  const changePct = ((market.priceUsd - config.basePrice) / config.basePrice) * 100;
  const upperHit = changePct >= config.percent;
  const lowerHit = changePct <= -config.percent;

  if (armed) {
    if (upperHit || lowerHit) {
      return { fired: true, newArmed: false, shouldDeactivate: config.mode === "one_shot" };
    }
    return NOT_FIRED(true);
  }

  // Rearm once price settles back within the hysteresis band around the base price.
  if (Math.abs(changePct) < config.hysteresisPct) return NOT_FIRED(true);
  return NOT_FIRED(false);
}

export interface TrendEvalContext {
  market: MarketSnapshot;
  history: SnapshotRow[]; // prior snapshots, oldest first, NOT including the current market poll
  lastFiredAt: number | null;
  now: number;
}

export function evaluateTrend(config: TrendConfig, ctx: TrendEvalContext): EvaluationOutcome {
  const { market, history, lastFiredAt, now } = ctx;

  if (lastFiredAt !== null) {
    const cooldownMs = config.cooldownMinutes * 60_000;
    if (now - lastFiredAt < cooldownMs) return NOT_FIRED(true);
  }

  const m5 = market.priceChangeM5;
  const h1 = market.priceChangeH1;
  if (m5 === null || h1 === null) return NOT_FIRED(true);

  const isUp = config.direction === "up";
  const m5Ok = isUp ? m5 >= config.m5ChangePct : m5 <= -config.m5ChangePct;
  const h1Ok = isUp ? h1 >= config.h1ChangePct : h1 <= -config.h1ChangePct;
  if (!m5Ok || !h1Ok) return NOT_FIRED(true);

  const volumeSamples = history.map((h) => h.volume_m5).filter((v): v is number => v !== null);
  if (volumeSamples.length === 0) return NOT_FIRED(true);
  const avgVolume = volumeSamples.reduce((sum, v) => sum + v, 0) / volumeSamples.length;
  const currentVolume = market.volumeM5 ?? 0;
  if (avgVolume <= 0 || currentVolume < avgVolume * config.volumeMultiplier) return NOT_FIRED(true);

  const priceSeries = [...history.map((h) => h.price_usd), market.priceUsd];
  if (priceSeries.length < config.consecutivePolls) return NOT_FIRED(true);

  const tail = priceSeries.slice(-config.consecutivePolls);
  let monotonic = true;
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1]!;
    const curr = tail[i]!;
    if (isUp ? curr <= prev : curr >= prev) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic) return NOT_FIRED(true);

  return { fired: true, newArmed: true, shouldDeactivate: false };
}

export function evaluateRule(
  config: RuleConfig,
  armed: boolean,
  market: MarketSnapshot,
  history: SnapshotRow[],
  lastFiredAt: number | null,
  now: number = Date.now()
): EvaluationOutcome {
  switch (config.kind) {
    case "threshold":
      return evaluateThreshold(config, market, armed);
    case "percent_move":
      return evaluatePercentMove(config, market, armed);
    case "trend":
      return evaluateTrend(config, { market, history, lastFiredAt, now });
  }
}
