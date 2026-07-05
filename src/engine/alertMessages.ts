import { formatCompactUsd, formatPercent } from "../util/numberParser.js";
import type {
  MarketSnapshot,
  PercentMoveConfig,
  RuleConfig,
  ThresholdConfig,
  TokenRow,
  TrendConfig,
  WatchRow,
} from "../types/domain.js";

export interface AlertText {
  title: string;
  body: string;
}

export function metricLabel(metric: ThresholdConfig["metric"]): string {
  if (metric === "mcap") return "MCap";
  if (metric === "price") return "Price";
  return "Liquidity";
}

function metricValue(metric: ThresholdConfig["metric"], market: MarketSnapshot): number | null {
  if (metric === "mcap") return market.mcap;
  if (metric === "price") return market.priceUsd;
  return market.liquidityUsd;
}

function formatMetric(metric: ThresholdConfig["metric"], value: number): string {
  if (metric === "price") return formatCompactUsd(value);
  return formatCompactUsd(value);
}

export function buildThresholdAlert(
  config: ThresholdConfig,
  market: MarketSnapshot,
  watch: WatchRow,
  token: TokenRow
): AlertText {
  const current = metricValue(config.metric, market) ?? 0;
  const verb = config.condition === "below" ? "dropped to" : "rose to";
  const label = metricLabel(config.metric);

  const initial =
    config.metric === "mcap"
      ? watch.initial_mcap
      : config.metric === "liquidity"
        ? watch.initial_liquidity_usd
        : watch.initial_price_usd;

  const changeLine =
    initial !== null && initial !== undefined && initial !== 0
      ? `Was ${formatMetric(config.metric, initial)} when you added it (${formatPercent(
          ((current - initial) / initial) * 100
        )})`
      : "";

  const title = `🚨 TARGET HIT — ${token.symbol}`;
  const lines = [
    `${label} ${verb} ${formatMetric(config.metric, current)} (your target: ${formatMetric(
      config.metric,
      config.value
    )})`,
  ];
  if (changeLine) lines.push(changeLine);
  lines.push(
    `💲 ${formatCompactUsd(market.priceUsd)} | 💧 Liq ${market.liquidityUsd !== null ? formatCompactUsd(market.liquidityUsd) : "N/A"}`
  );

  return { title, body: lines.join("\n") };
}

export function buildTrendAlert(config: TrendConfig, market: MarketSnapshot, token: TokenRow): AlertText {
  const isUp = config.direction === "up";
  const title = `${isUp ? "📈" : "📉"} ${isUp ? "Uptrend" : "Downtrend"} starting — ${token.symbol}`;
  const lines = [
    `5m: ${formatPercent(market.priceChangeM5 ?? 0)} | 1h: ${formatPercent(market.priceChangeH1 ?? 0)}`,
    `💲 ${formatCompactUsd(market.priceUsd)} | 📊 MCap ${market.mcap !== null ? formatCompactUsd(market.mcap) : "N/A"}`,
    `💧 Liq ${market.liquidityUsd !== null ? formatCompactUsd(market.liquidityUsd) : "N/A"} | Vol 5m ${market.volumeM5 !== null ? formatCompactUsd(market.volumeM5) : "N/A"}`,
  ];
  return { title, body: lines.join("\n") };
}

export function buildPercentMoveAlert(
  config: PercentMoveConfig,
  market: MarketSnapshot,
  token: TokenRow
): AlertText {
  const changePct = ((market.priceUsd - config.basePrice) / config.basePrice) * 100;
  const direction = changePct >= 0 ? "up" : "down";
  const title = `↕️ ${token.symbol} moved ${direction} ${formatPercent(Math.abs(changePct))}`;
  const lines = [
    `Price ${formatCompactUsd(market.priceUsd)} vs ${formatCompactUsd(config.basePrice)} when the alert was set`,
    `📊 MCap ${market.mcap !== null ? formatCompactUsd(market.mcap) : "N/A"} | 💧 Liq ${market.liquidityUsd !== null ? formatCompactUsd(market.liquidityUsd) : "N/A"}`,
  ];
  return { title, body: lines.join("\n") };
}

export function buildAlertText(
  config: RuleConfig,
  market: MarketSnapshot,
  watch: WatchRow,
  token: TokenRow
): AlertText {
  switch (config.kind) {
    case "threshold":
      return buildThresholdAlert(config, market, watch, token);
    case "trend":
      return buildTrendAlert(config, market, token);
    case "percent_move":
      return buildPercentMoveAlert(config, market, token);
  }
}

export function buildNotIndexedAlert(token: TokenRow): AlertText {
  return {
    title: `⚠️ ${token.symbol} no longer indexed`,
    body: `DexScreener stopped returning data for this pair (it may have been rugged or delisted). Its rules have been paused.`,
  };
}
