import { describe, it, expect } from 'vitest';
import { PriceCurve, reconcilePeak } from '../src/engine/priceCurve.js';

describe('the curve sorts its input', () => {
  it('reports the earliest trade as first, whatever order they arrive in', () => {
    // Out-of-order input does not degrade this answer, it corrupts it: `first`
    // reads index 0 and `peak` binary-searches the timestamps.
    const t = (ts: number, price: number) =>
      ({ ts, priceUsd: price, mcap: price * 1e9, wallet: 'w', side: 'buy', tokenAmount: 1, usd: 1, tx: 'x' }) as never;
    const curve = new PriceCurve([t(5000, 9e-4), t(100, 4e-6), t(900, 5e-6)]);
    expect(curve.first!.ts).toBe(100);
    expect(curve.last!.ts).toBe(5000);
  });

  it('finds the true peak inside a window given unsorted input', () => {
    // A binary search over unsorted timestamps silently returns the wrong slice.
    const t = (ts: number, price: number) =>
      ({ ts, priceUsd: price, mcap: price * 1e9, wallet: 'w', side: 'buy', tokenAmount: 1, usd: 1, tx: 'x' }) as never;
    const curve = new PriceCurve([t(300, 3e-6), t(100, 1e-6), t(200, 9e-6)]);
    expect(curve.peak(100, 300)).toBeCloseTo(9e-6 * 1e9, 6);
  });
});

describe('a peak is not set by one bad print', () => {
  it('prefers the candle high when the trades claim far more', async () => {
    // A lone sell of 681 tokens for $23 implied a $33.9M market cap on a token
    // whose real top was $20.4M, and credited a wallet with riding 5325x
    // instead of ~3200x. The outlier filter cannot catch it: that print sat
    // 1.8x above its neighbours, inside the 10x tolerance that protects real
    // launch ramps.
    const { reconcilePeak } = await import('../src/engine/priceCurve.js');
    expect(reconcilePeak(33_908_468, 20_449_118)).toBe(20_449_118);
  });

  it('keeps a trade peak that only modestly exceeds the candles', () => {
    // The replay reads several pools while the candles cover one, so a small
    // excess is ordinary rather than suspicious.
    expect(reconcilePeak(21_000_000, 20_000_000)).toBe(21_000_000);
  });

  it('trusts the trades when there are no candles at all', () => {
    expect(reconcilePeak(5_000, 0)).toBe(5_000);
  });

  it('uses the candles when the replay never reached that period', () => {
    expect(reconcilePeak(0, 900_000)).toBe(900_000);
  });
});
