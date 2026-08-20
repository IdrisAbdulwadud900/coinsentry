import type { Trade } from '../types/domain.js';
import type { CandleIndex } from '../data/ohlcv.js';

/**
 * The token's price/market-cap history, reconstructed from its own trades.
 *
 * Supports two queries the analysis depends on:
 *  - `at(ts)`      — what a token was worth at some moment (prices transfers)
 *  - `peak(a, b)`  — the highest market cap between two moments, which is how
 *                    "they rode it to 8x before selling" is measured.
 *
 * `peak` is answered in O(1) with a sparse table, because it runs once per
 * wallet and a token can have tens of thousands of them.
 */
/**
 * How far a reconstructed print may exceed the candle high before it is treated
 * as an artifact rather than a price.
 *
 * Pools stay arbitraged within a few percent of each other, so a reconstruction
 * that claims a price far above what the indexed pool ever printed is not a
 * trade nobody indexed — it is a bad reconstruction. A margin is still needed
 * because the replay reads several pools while the candles cover one, and
 * because candle granularity is coarser than a single swap.
 */
const CANDLE_PEAK_TOLERANCE = 1.25;

/**
 * Reconciles the highest price the trades saw with the highest the candles saw.
 *
 * Taking the larger of the two was wrong in one direction: a peak is a MAXIMUM,
 * so it is decided by the single most extreme print, and one bad reconstruction
 * sets it however sound every other trade is. On one Base token a lone sell of
 * 681 tokens for $23 implied a $33.9M market cap while the real top was
 * $20.4M — a 66% overstatement that also credited a wallet with riding 5325x
 * instead of about 3200x.
 *
 * The outlier filter cannot catch this and should not be asked to: that print
 * sat only 1.8x above its neighbours, far inside the 10x tolerance that
 * protects genuine launch ramps. Candles are the better authority here because
 * they are aggregated independently and cannot contain our reconstruction's
 * mistakes.
 */
export function reconcilePeak(fromTrades: number, fromCandles: number): number {
  if (fromCandles <= 0) return fromTrades;
  if (fromTrades > fromCandles * CANDLE_PEAK_TOLERANCE) return fromCandles;
  return Math.max(fromTrades, fromCandles);
}

export class PriceCurve {
  private readonly ts: number[] = [];
  private readonly price: number[] = [];
  private readonly mcap: number[] = [];
  /** sparse[k][i] = max mcap over [i, i + 2^k). */
  private readonly sparse: Float64Array[] = [];
  private readonly logTable: Int32Array;

  /**
   * Candle highs covering the token's whole life. Our replayed trades only
   * cover a window, so a peak taken from them alone is a lower bound; candles
   * make the answer independent of how much of the chain we read.
   */
  private candles: CandleIndex | null = null;
  /** Price-per-token to market-cap multiplier, for candle values. */
  private supply = 0;

  constructor(trades: Trade[]) {
    // Every print is kept. An earlier version collapsed same-second trades to
    // the highest one, which silently discarded the lowest print of that second
    // — so the reported floor came out above market caps that wallets had
    // demonstrably bought at, and their entries appeared to predate the floor.
    // Solana packs many trades into one second, so this was not an edge case.
    //
    // Sorted here rather than trusted from the caller. Everything below assumes
    // ascending time — `first` reads index 0, and `peak` binary-searches `ts`
    // for the window — so a single out-of-order trade does not degrade the
    // answer, it corrupts it silently. That happened for real: retried log
    // chunks were appended after the rest, which put recent trades before the
    // launch and reported a two-day-old coin as thirteen hours old with no
    // diamond hands at all.
    const usable = trades
      .filter(
        (t) =>
          Number.isFinite(t.priceUsd) && t.priceUsd > 0 && Number.isFinite(t.mcap) && t.mcap > 0,
      )
      .sort((a, b) => a.ts - b.ts);

    for (const t of usable) {
      this.ts.push(t.ts);
      this.price.push(t.priceUsd);
      this.mcap.push(t.mcap);
    }

    const n = this.mcap.length;
    this.logTable = new Int32Array(Math.max(2, n + 1));
    for (let i = 2; i <= n; i++) this.logTable[i] = this.logTable[i >> 1]! + 1;

    if (n > 0) {
      const levels = this.logTable[n]! + 1;
      this.sparse.push(Float64Array.from(this.mcap));
      for (let k = 1; k < levels; k++) {
        const len = n - (1 << k) + 1;
        if (len <= 0) break;
        const prev = this.sparse[k - 1]!;
        const cur = new Float64Array(len);
        const half = 1 << (k - 1);
        for (let i = 0; i < len; i++) cur[i] = Math.max(prev[i]!, prev[i + half]!);
        this.sparse.push(cur);
      }
    }
  }

  /** Attaches candle coverage. `totalSupply` converts candle prices to caps. */
  withCandles(index: CandleIndex, totalSupply: number): this {
    if (index.length > 0 && totalSupply > 0) {
      this.candles = index;
      this.supply = totalSupply;
    }
    return this;
  }

  get hasCandles(): boolean {
    return this.candles !== null;
  }

  get length(): number {
    return this.ts.length;
  }
  get first(): { ts: number; mcap: number; price: number } | null {
    return this.ts.length ? { ts: this.ts[0]!, mcap: this.mcap[0]!, price: this.price[0]! } : null;
  }
  get last(): { ts: number; mcap: number; price: number } | null {
    const i = this.ts.length - 1;
    return i >= 0 ? { ts: this.ts[i]!, mcap: this.mcap[i]!, price: this.price[i]! } : null;
  }

  /** Lowest market cap ever printed — the coin's actual floor. */
  get floorMcap(): number {
    let min = Infinity;
    for (const m of this.mcap) if (m > 0 && m < min) min = m;
    // Candles reach back further than the replay, so they can only lower this.
    if (this.candles) {
      const candleFloor = this.candles.floor * this.supply;
      if (candleFloor > 0 && candleFloor < min) min = candleFloor;
    }
    return Number.isFinite(min) ? min : 0;
  }

  get peakMcap(): number {
    const fromTrades = this.peakIndex(0, this.mcap.length - 1);
    const fromCandles = this.candles ? this.candles.high * this.supply : 0;
    return reconcilePeak(fromTrades, fromCandles);
  }

  /** Index of the last sample at or before `t`. */
  private indexAt(t: number): number {
    if (this.ts.length === 0) return -1;
    if (t <= this.ts[0]!) return 0;
    if (t >= this.ts[this.ts.length - 1]!) return this.ts.length - 1;
    let lo = 0;
    let hi = this.ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  priceAt(t: number): number {
    const i = this.indexAt(t);
    return i < 0 ? 0 : this.price[i]!;
  }

  mcapAt(t: number): number {
    const i = this.indexAt(t);
    return i < 0 ? 0 : this.mcap[i]!;
  }

  /** First index whose timestamp is >= t, or length when none is. */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Highest market cap printed in [fromTs, toTs]. */
  peak(fromTs: number, toTs: number): number {
    if (toTs < fromTs) return 0;

    // Candles are consulted first and independently: they can cover periods the
    // replay never reached, so an empty trade list must not short-circuit them.
    const fromCandles = this.candles ? this.candles.peak(fromTs, toTs) * this.supply : 0;
    if (this.mcap.length === 0) return fromCandles;

    // The replay covers a window, and a wallet's holding period often sits
    // entirely outside it. Falling back to the nearest known price then reports
    // a market cap from months after the wallet exited as the peak it rode —
    // one wallet that held forty seconds was credited with 4595x that way.
    // No overlap means the trades know nothing about this period.
    const first = this.ts[0]!;
    const last = this.ts[this.ts.length - 1]!;
    if (toTs < first || fromTs > last) return fromCandles;

    // Duplicate timestamps are normal, so the window start must be the FIRST
    // sample at or after fromTs, not the last one at or before it.
    const lo = this.lowerBound(fromTs);
    const hi = this.indexAt(toTs);
    const fromTrades = lo >= this.ts.length || hi < lo ? 0 : this.peakIndex(lo, hi);

    return reconcilePeak(fromTrades, fromCandles);
  }

  private peakIndex(lo: number, hi: number): number {
    if (lo < 0 || hi < lo || this.sparse.length === 0) return 0;
    const k = this.logTable[hi - lo + 1]!;
    const level = this.sparse[k];
    if (!level) return this.mcap[lo] ?? 0;
    const a = level[lo] ?? 0;
    const b = level[hi - (1 << k) + 1] ?? 0;
    return Math.max(a, b);
  }

  /**
   * Market-cap series for the sparkline.
   *
   * Candles are preferred whenever available, for two reasons. They span the
   * token's whole life, so the chart matches the "launch $2.2k → now $10.7M"
   * line printed directly above it instead of drawing only the recent window
   * the replay happened to cover. And they are evenly spaced in TIME, whereas
   * sampling trades by index compresses quiet stretches and stretches busy
   * ones, producing a shape that does not correspond to the coin's timeline.
   */
  series(points = 24): number[] {
    if (this.candles && this.supply > 0) {
      const closes = this.candles.closeSeries(points);
      if (closes.length > 0) return closes.map((c) => c * this.supply);
    }
    if (this.mcap.length === 0) return [];
    if (this.mcap.length <= points) return [...this.mcap];
    const out: number[] = [];
    const per = this.mcap.length / points;
    for (let i = 0; i < points; i++) {
      out.push(this.mcap[Math.min(this.mcap.length - 1, Math.floor(i * per))]!);
    }
    return out;
  }
}
