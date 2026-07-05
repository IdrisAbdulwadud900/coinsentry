export interface TokenRow {
  id: number;
  chain_id: string;
  dex_id: string;
  pair_address: string;
  token_address: string;
  symbol: string;
  name: string;
  pair_url: string;
  is_indexed: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface WatchRow {
  id: number;
  chat_id: number;
  token_id: number;
  added_at: number;
  initial_price_usd: number;
  initial_mcap: number | null;
  initial_liquidity_usd: number | null;
}

export type RuleType = "threshold" | "trend" | "percent_move";
export type ThresholdMetric = "mcap" | "price" | "liquidity";
export type ThresholdCondition = "below" | "above";
export type RuleMode = "one_shot" | "repeating";
export type TrendDirection = "up" | "down";

export interface ThresholdConfig {
  kind: "threshold";
  metric: ThresholdMetric;
  condition: ThresholdCondition;
  value: number;
  mode: RuleMode;
  hysteresisPct: number;
}

export interface TrendConfig {
  kind: "trend";
  direction: TrendDirection;
  m5ChangePct: number;
  h1ChangePct: number;
  volumeMultiplier: number;
  consecutivePolls: number;
  cooldownMinutes: number;
}

export interface PercentMoveConfig {
  kind: "percent_move";
  basePrice: number;
  percent: number;
  mode: RuleMode;
  hysteresisPct: number;
}

export type RuleConfig = ThresholdConfig | TrendConfig | PercentMoveConfig;

export interface RuleRow {
  id: number;
  chat_id: number;
  watch_id: number;
  token_id: number;
  type: RuleType;
  config_json: string;
  armed: 0 | 1;
  active: 0 | 1;
  last_fired_at: number | null;
  created_at: number;
}

export interface SnapshotRow {
  id: number;
  token_id: number;
  ts: number;
  price_usd: number;
  mcap: number | null;
  liquidity_usd: number | null;
  volume_m5: number | null;
  volume_h1: number | null;
  volume_h24: number | null;
  price_change_m5: number | null;
  price_change_h1: number | null;
  price_change_h6: number | null;
  price_change_h24: number | null;
}

export interface SettingsRow {
  chat_id: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
  currency_locale: string | null;
}

export interface PendingDigestRow {
  id: number;
  chat_id: number;
  message_text: string;
  reply_markup_json: string | null;
  created_at: number;
}

/** A normalized view of a token's current market data, derived from the
 * DexScreener API response for a single pair. */
export interface MarketSnapshot {
  chainId: string;
  dexId: string;
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  pairUrl: string;
  priceUsd: number;
  mcap: number | null;
  liquidityUsd: number | null;
  volumeM5: number | null;
  volumeH1: number | null;
  volumeH24: number | null;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;
  priceChangeH24: number | null;
}

export interface AlertFireResult {
  rule: RuleRow;
  title: string;
  body: string;
}
