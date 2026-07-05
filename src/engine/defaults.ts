import type { TrendConfig } from "../types/domain.js";

export const DEFAULT_TREND_PARAMS: Omit<TrendConfig, "kind" | "direction"> = {
  m5ChangePct: 4,
  h1ChangePct: 0,
  volumeMultiplier: 1.5,
  consecutivePolls: 3,
  cooldownMinutes: 30,
};

export const DEFAULT_HYSTERESIS_PCT = 3;
