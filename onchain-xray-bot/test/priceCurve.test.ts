import { describe, it, expect } from 'vitest';
import { PriceCurve } from '../src/engine/priceCurve.js';

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
