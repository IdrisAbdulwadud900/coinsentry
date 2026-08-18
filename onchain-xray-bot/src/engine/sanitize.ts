import { config } from '../config.js';
import type { Trade } from '../types/domain.js';

/**
 * Removes trades whose implied price cannot be real.
 *
 * A genuine price move is continuous: the trades around it print at similar
 * levels. An isolated spike that no neighbouring trade agrees with is an
 * artifact of how the swap was reconstructed — most often account rent or
 * priority fees being counted as payment, which inflates the implied price of
 * a trade that moved almost no value.
 *
 * The tolerance is deliberately size-aware. A large trade that prints far from
 * its neighbours probably moved the market and should be kept; a dust trade
 * that does the same moved nothing and cannot have. Comparing against a local
 * median rather than a global one means a launch that genuinely ramps 100x is
 * preserved, because its neighbours ramp with it.
 */
export function rejectPriceOutliers(trades: Trade[]): { trades: Trade[]; dropped: number } {
  const n = trades.length;
  if (n < config.OUTLIER_MIN_SAMPLES) return { trades, dropped: 0 };

  const half = Math.max(2, Math.floor(config.OUTLIER_WINDOW / 2));
  const kept: Trade[] = [];
  let dropped = 0;

  for (let i = 0; i < n; i++) {
    const t = trades[i]!;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);

    // Local median price, excluding the trade under test so a cluster of
    // artifacts cannot vouch for itself.
    const neighbours: number[] = [];
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const p = trades[j]!.priceUsd;
      if (Number.isFinite(p) && p > 0) neighbours.push(p);
    }
    if (neighbours.length < 4) {
      kept.push(t);
      continue;
    }
    neighbours.sort((a, b) => a - b);
    const median = neighbours[Math.floor(neighbours.length / 2)]!;
    if (median <= 0) {
      kept.push(t);
      continue;
    }

    const deviation = t.priceUsd > median ? t.priceUsd / median : median / t.priceUsd;
    const limit =
      t.usd < config.OUTLIER_SMALL_TRADE_USD
        ? config.OUTLIER_SMALL_DEVIATION
        : config.OUTLIER_DEVIATION;

    if (deviation > limit) {
      dropped++;
      continue;
    }
    kept.push(t);
  }

  return { trades: kept, dropped };
}
