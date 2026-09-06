import { describe, it, expect } from 'vitest';
import { buildProviderEntries } from '../src/engine/providerEntries.js';
import type { FirstBuyer } from '../src/data/solanatracker.js';
import type { ProviderEntry } from '../src/types/domain.js';
import { makeProviderEntry } from './fixtures.js';

const SUPPLY = 1_000_000_000;
const ctx = { floorMcap: 2_100, floorBandMax: 3_675, firstTradeTs: 1_000, totalSupply: SUPPLY };

function buyer(over: Partial<FirstBuyer> = {}): FirstBuyer {
  return {
    wallet: 'W1',
    // 1M tokens for $3 => $0.000003/token => $3,000 market cap on 1B supply.
    entryTokens: 1_000_000,
    entryUsd: 3,
    firstBuyTs: 1_010,
    firstSellTs: null,
    lastActivityTs: 2_000,
    heldTokens: 1_000_000,
    holdingTokens: 1_000_000,
    soldTokens: 0,
    totalInvestedUsd: 300,
    totalSoldUsd: 0,
    realizedUsd: 0,
    unrealizedUsd: 500,
    totalPnlUsd: 500,
    costBasisUsd: 0.000003,
    buyCount: 3,
    sellCount: 0,
    ...over,
  };
}

describe('buildProviderEntries', () => {
  it('derives an exact entry market cap from the first buy', () => {
    const [e] = buildProviderEntries([buyer()], ctx, 0.00001);
    expect(e!.entryMcap).toBeCloseTo(3_000, 0);
    expect(e!.tier).toBe('floor');
  });

  it('drops wallets whose entry was above the early tiers', () => {
    // 1M tokens for $300 => $300k market cap. Way past the floor band.
    const late = buyer({ entryUsd: 300 });
    expect(buildProviderEntries([late], ctx, 0.00001)).toHaveLength(0);
  });

  it('applies the same coin-scaled position floor as the rest of the bot', () => {
    const dust = buyer({ totalInvestedUsd: 0.4, entryUsd: 0.4, entryTokens: 133_333 });
    expect(buildProviderEntries([dust], ctx, 0.00001)).toHaveLength(0);
  });

  it('ranks by entry time across all buyers, not just the kept ones', () => {
    const a = buyer({ wallet: 'A', firstBuyTs: 1_005 });
    const b = buyer({ wallet: 'B', firstBuyTs: 1_002 });
    const out = buildProviderEntries([a, b], ctx, 0.00001);
    expect(out.find((e) => e.wallet === 'B')!.entryRank).toBe(1);
    expect(out.find((e) => e.wallet === 'A')!.entryRank).toBe(2);
  });

  it('treats leftover dust as exited rather than still holding', () => {
    const dusted = buyer({ heldTokens: 1_000_000, holdingTokens: 500, sellCount: 4 });
    expect(buildProviderEntries([dusted], ctx, 0.00001)[0]!.stillHolding).toBe(false);
  });

  it('reports hold time when the wallet has sold', () => {
    const sold = buyer({ firstBuyTs: 1_000, firstSellTs: 4_600 });
    expect(buildProviderEntries([sold], ctx, 0.00001)[0]!.holdSeconds).toBe(3_600);
  });

  it('skips records with no usable first buy', () => {
    expect(buildProviderEntries([buyer({ entryTokens: 0 })], ctx, 0.00001)).toHaveLength(0);
    expect(buildProviderEntries([buyer({ entryUsd: 0 })], ctx, 0.00001)).toHaveLength(0);
  });
});

describe('realized multiple ignores the provider cost_basis field', () => {
  it('derives the buy price from figures with unambiguous units', () => {
    // Real record from $TRIPLET wallet #1. Its cost_basis field reads 0.01167,
    // roughly 3000x the actual per-token price, which rendered a wallet that
    // nearly tripled its money as "0.00x".
    const real = buyer({
      entryTokens: 124_858_181.763706,
      entryUsd: 303.69083944,
      heldTokens: 132_200_779.317334,
      holdingTokens: 4_599.336134,
      soldTokens: 131_822_146.899124,
      totalInvestedUsd: 491.9030697,
      totalSoldUsd: 1_351.0952472,
      totalPnlUsd: 909.06814186,
      costBasisUsd: 0.01166749,
      sellCount: 7,
    });
    const [e] = buildProviderEntries([real], { ...ctx, floorMcap: 2_100, floorBandMax: 3_675 }, 0.00001);

    expect(e!.realizedMultiple).toBeCloseTo(2.755, 2);
    // Cross-check: +$909 profit on $492 invested is a ~2.8x round trip.
    expect(e!.realizedMultiple).toBeGreaterThan(2);
    expect(e!.realizedMultiple).toBeLessThan(4);
  });

  it('falls back to the first-buy price when totals are missing', () => {
    // 10M tokens for $30 => $3e-6 each => $3,000 market cap, and a position
    // large enough to clear the coin-scaled floor.
    const sparse = buyer({
      entryTokens: 10_000_000,
      entryUsd: 30,
      heldTokens: 0,
      totalInvestedUsd: 0,
      soldTokens: 10_000_000,
      totalSoldUsd: 120,
    });
    const [e] = buildProviderEntries([sparse], ctx, 0.00001);
    // entry price 3e-6, avg sell 1.2e-5 => 4x
    expect(e!.realizedMultiple).toBeCloseTo(4, 2);
  });
});

describe('hold-through-the-run from candles', () => {
  it('stays zero when no candle coverage exists rather than guessing', () => {
    const [e] = buildProviderEntries([buyer()], ctx, 0.00001);
    expect(e!.heldMultiple).toBe(0);
    expect(e!.peakMcapBeforeFirstSell).toBe(0);
  });

  it('measures the peak between entry and first sell', async () => {
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    const { CandleIndex } = await import('../src/data/ohlcv.js');

    // Coin ran to $0.00003 (30k mcap on 1B supply) while this wallet held.
    const series = {
      candles: [
        { ts: 1_000, open: 3e-6, high: 4e-6, low: 3e-6, close: 4e-6, period: 1_000 },
        { ts: 2_000, open: 4e-6, high: 3e-5, low: 4e-6, close: 2e-5, period: 1_000 },
        { ts: 3_000, open: 2e-5, high: 9e-5, low: 2e-5, close: 9e-5, period: 1_000 },
      ],
      periodSeconds: 1_000,
      coversFrom: 1_000,
    };
    const curve = new PriceCurve([]).withCandles(new CandleIndex(series), SUPPLY);

    // Held across the first two candles, both fully inside the window.
    const held = buyer({ firstBuyTs: 1_000, firstSellTs: 3_000 });
    const [e] = buildProviderEntries([held], ctx, 0.00001, curve);

    // Candles [1000,2000] and [2000,3000] qualify; the highest is 3e-5 =>
    // $30,000 mcap => 10x on a $3k entry.
    expect(e!.peakMcapBeforeFirstSell).toBeCloseTo(30_000, 0);
    expect(e!.heldMultiple).toBeCloseTo(10, 1);
    // The 9e-5 candle spans [3000,4000], past the sell, and must not count.
    expect(e!.heldMultiple).toBeLessThan(30);
  });

  it('reports unknown rather than crediting a hold shorter than one candle', async () => {
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    const { CandleIndex } = await import('../src/data/ohlcv.js');
    // Hourly candles; the wallet held 40 seconds. The candle's high says
    // nothing about those 40 seconds, so this must not become "rode 4597x".
    const series = {
      candles: [{ ts: 1_000, open: 3e-6, high: 1.4e-2, low: 3e-6, close: 1e-2, period: 3_600 }],
      periodSeconds: 3_600,
      coversFrom: 1_000,
    };
    const curve = new PriceCurve([]).withCandles(new CandleIndex(series), SUPPLY);
    const flipper = buyer({ firstBuyTs: 1_200, firstSellTs: 1_240 });
    const [e] = buildProviderEntries([flipper], ctx, 0.00001, curve);
    expect(e!.heldMultiple).toBe(0);
  });

  it('runs to now for a wallet that never sold', async () => {
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    const { CandleIndex } = await import('../src/data/ohlcv.js');
    const now = Math.floor(Date.now() / 1000);
    const series = {
      candles: [
        { ts: now - 3_000, open: 3e-6, high: 6e-5, low: 3e-6, close: 6e-5, period: 1_000 },
        { ts: now - 2_000, open: 6e-5, high: 6e-5, low: 5e-5, close: 6e-5, period: 1_000 },
      ],
      periodSeconds: 1_000,
      coversFrom: now - 3_000,
    };
    const curve = new PriceCurve([]).withCandles(new CandleIndex(series), SUPPLY);
    const holder = buyer({ firstBuyTs: now - 3_000, firstSellTs: null });
    const [e] = buildProviderEntries([holder], ctx, 0.00001, curve);
    expect(e!.heldMultiple).toBeCloseTo(20, 1);
  });
});

describe('mixed candle timeframes', () => {
  it('never credits a day-long candle to an hour-long hold', async () => {
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    const { CandleIndex } = await import('../src/data/ohlcv.js');

    // Real shape for an older token: daily candles cover the launch period,
    // hourly candles only reach the recent weeks. Storing one series-wide
    // period would treat the daily candle as an hour and hand a two-hour hold
    // the whole day's range.
    const series = {
      candles: [
        { ts: 0, open: 3e-6, high: 9e-3, low: 3e-6, close: 5e-3, period: 86_400 },
        { ts: 86_400, open: 5e-3, high: 6e-3, low: 4e-3, close: 6e-3, period: 86_400 },
      ],
      periodSeconds: 3_600,
      coversFrom: 0,
    };
    const curve = new PriceCurve([]).withCandles(new CandleIndex(series), SUPPLY);

    // Held two hours inside the first day. The day's high says nothing about it.
    const short = buyer({ firstBuyTs: 3_600, firstSellTs: 10_800 });
    expect(buildProviderEntries([short], ctx, 0.00001, curve)[0]!.heldMultiple).toBe(0);

    // Held across the whole first day, which IS fully contained.
    const full = buyer({ firstBuyTs: 0, firstSellTs: 86_400 });
    const [e] = buildProviderEntries([full], ctx, 0.00001, curve);
    expect(e!.peakMcapBeforeFirstSell).toBeCloseTo(9e-3 * SUPPLY, 0);
  });
});

describe('supply that left without a sale', () => {
  const entry = (over: Partial<ProviderEntry>): ProviderEntry =>
    makeProviderEntry({ movedOutTokens: 0, everHeldTokens: 1_000_000, ...over });

  it('finds a wallet whose tokens left without being sold', async () => {
    // Acquired minus sold minus still-held is supply that was transferred out.
    // It is the source half of a relay and needs no replay to see, which is
    // what makes it usable on a coin far too large to replay.
    const { movedSupplyOut } = await import('../src/engine/providerEntries.js');
    const out = movedSupplyOut([
      entry({ wallet: 'MOVER', movedOutTokens: 540_000 }),
      entry({ wallet: 'SOLD', movedOutTokens: 0 }),
    ]);
    expect(out.map((e) => e.wallet)).toEqual(['MOVER']);
  });

  it('ignores dust left behind by a full exit', async () => {
    const { movedSupplyOut } = await import('../src/engine/providerEntries.js');
    expect(movedSupplyOut([entry({ movedOutTokens: 500 })])).toHaveLength(0);
  });

  it('measures against everything acquired, not what remains', async () => {
    // A wallet that sold 90% and moved 2% has not moved most of its position;
    // using the wrong denominator would report it as if it had.
    const { movedSupplyOut } = await import('../src/engine/providerEntries.js');
    const out = movedSupplyOut([entry({ movedOutTokens: 20_000, everHeldTokens: 1_000_000 })]);
    expect(out).toHaveLength(0);
  });

  it('ranks the biggest movers first', async () => {
    const { movedSupplyOut } = await import('../src/engine/providerEntries.js');
    const out = movedSupplyOut([
      entry({ wallet: 'SMALL', movedOutTokens: 100_000 }),
      entry({ wallet: 'BIG', movedOutTokens: 800_000 }),
    ]);
    expect(out.map((e) => e.wallet)).toEqual(['BIG', 'SMALL']);
  });
});
