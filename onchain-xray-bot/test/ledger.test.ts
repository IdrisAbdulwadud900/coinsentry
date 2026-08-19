import { describe, it, expect } from 'vitest';
import { PriceCurve } from '../src/engine/priceCurve.js';
import { buildLedgers, priceTransfers } from '../src/engine/ledger.js';
import { findEarlyBuyers, findDiamondHands, classifyEntry, minPositionUsd, resolveEntryBand } from '../src/engine/entries.js';
import { findSupplyRelays } from '../src/engine/supplyRelay.js';
import type { Trade, SupplyTransfer } from '../src/types/domain.js';

const SUPPLY = 1_000_000_000;

function trade(p: Partial<Trade> & Pick<Trade, 'ts' | 'wallet' | 'side' | 'tokenAmount' | 'priceUsd'>): Trade {
  return {
    usd: p.tokenAmount * p.priceUsd,
    mcap: p.priceUsd * SUPPLY,
    tx: p.tx ?? `tx-${p.ts}-${p.wallet}`,
    block: p.block ?? p.ts,
    ...p,
  } as Trade;
}

describe('PriceCurve', () => {
  const trades = [
    trade({ ts: 100, wallet: 'a', side: 'buy', tokenAmount: 1000, priceUsd: 0.000002 }), // 2k mcap
    trade({ ts: 200, wallet: 'b', side: 'buy', tokenAmount: 1000, priceUsd: 0.00002 }), // 20k
    trade({ ts: 300, wallet: 'c', side: 'buy', tokenAmount: 1000, priceUsd: 0.0002 }), // 200k
    trade({ ts: 400, wallet: 'd', side: 'buy', tokenAmount: 1000, priceUsd: 0.00001 }), // 10k
  ];
  const curve = new PriceCurve(trades);

  it('finds the floor and the peak', () => {
    expect(curve.floorMcap).toBeCloseTo(2_000, 0);
    expect(curve.peakMcap).toBeCloseTo(200_000, 0);
  });

  it('answers range-max queries over the window a wallet held', () => {
    expect(curve.peak(100, 200)).toBeCloseTo(20_000, 0);
    expect(curve.peak(100, 400)).toBeCloseTo(200_000, 0);
    expect(curve.peak(300, 400)).toBeCloseTo(200_000, 0);
    // A window that starts after the peak must not see it.
    expect(curve.peak(400, 400)).toBeCloseTo(10_000, 0);
  });

  it('prices a moment by the last trade at or before it', () => {
    expect(curve.priceAt(250)).toBeCloseTo(0.00002, 10);
    expect(curve.priceAt(50)).toBeCloseTo(0.000002, 10);
  });
});

describe('buildLedgers', () => {
  it('computes entry, realized PnL and peak-while-holding', () => {
    const trades = [
      // Enters at 2k mcap, sells after the run to 200k.
      trade({ ts: 100, wallet: 'early', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 200, wallet: 'other', side: 'buy', tokenAmount: 1000, priceUsd: 0.00002 }),
      trade({ ts: 300, wallet: 'other', side: 'buy', tokenAmount: 1000, priceUsd: 0.0002 }),
      trade({ ts: 400, wallet: 'early', side: 'sell', tokenAmount: 50_000_000, priceUsd: 0.0001 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0001);
    const early = ledgers.get('early')!;

    expect(early.entryMcap).toBeCloseTo(2_000, 0);
    expect(early.totalBoughtUsd).toBeCloseTo(100, 5);
    expect(early.totalSoldUsd).toBeCloseTo(5000, 5);
    expect(early.realizedUsd).toBeCloseTo(4900, 5);
    // Rode 2k -> 200k before its first sell.
    expect(early.heldMultiple).toBeCloseTo(100, 0);
    expect(early.realizedMultiple).toBeCloseTo(50, 0);
    expect(early.fullyExited).toBe(true);
    expect(early.stillHolding).toBe(false);
  });

  it('treats received supply as zero-cost so it cannot fake a loss', () => {
    const trades = [trade({ ts: 100, wallet: 'sink', side: 'sell', tokenAmount: 500, priceUsd: 0.001 })];
    const transfers: SupplyTransfer[] = [
      { ts: 50, from: 'src', to: 'sink', tokenAmount: 500, usdAtTransfer: 0, tx: 't1', block: 50 },
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, transfers, curve, 0.001);
    const sink = ledgers.get('sink')!;

    expect(sink.receivedTokens).toBe(500);
    expect(sink.totalBoughtTokens).toBe(0);
    // Sold 500 at 0.001 with no cost basis to subtract.
    expect(sink.realizedUsd).toBeCloseTo(0.5, 6);
    expect(sink.balanceTokens).toBe(0);
  });
});

describe('entry classification', () => {
  const ctx = { floorMcap: 2_000, floorBandMax: 3_500, firstTradeTs: 100, totalSupply: SUPPLY };

  it('separates the coin-relative floor from the absolute early cap', () => {
    expect(classifyEntry(2_500, ctx)).toBe('floor');
    expect(classifyEntry(8_000, ctx)).toBe('sub10k');
    expect(classifyEntry(25_000, ctx)).toBe('early');
    expect(classifyEntry(500_000, ctx)).toBe('late');
  });
});

describe('findDiamondHands', () => {
  it('requires an early entry AND a 3x+ run before the first sell', () => {
    const trades = [
      trade({ ts: 100, wallet: 'diamond', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 150, wallet: 'flipper', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.0000021 }),
      // Flipper exits almost immediately, before any real run.
      trade({ ts: 160, wallet: 'flipper', side: 'sell', tokenAmount: 50_000_000, priceUsd: 0.0000024 }),
      trade({ ts: 300, wallet: 'late', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.0002 }),
      trade({ ts: 400, wallet: 'diamond', side: 'sell', tokenAmount: 50_000_000, priceUsd: 0.0001 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0001);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };

    const diamonds = findDiamondHands(ledgers, ctx);
    const wallets = diamonds.map((d) => d.ledger.wallet);

    expect(wallets).toContain('diamond');
    expect(wallets).not.toContain('flipper'); // sold before any 3x
    expect(wallets).not.toContain('late'); // entered at 200k, not early
  });
});

describe('findSupplyRelays', () => {
  it('flags an early buyer that exits through a second wallet', () => {
    const trades = [
      trade({ ts: 100, wallet: 'source', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 150, wallet: 'noise', side: 'buy', tokenAmount: 1000, priceUsd: 0.00002 }),
      // The sink never bought — it only received, then dumped.
      trade({ ts: 500, wallet: 'sink', side: 'sell', tokenAmount: 50_000_000, priceUsd: 0.0001 }),
    ];
    const transfers: SupplyTransfer[] = [
      { ts: 400, from: 'source', to: 'sink', tokenAmount: 50_000_000, usdAtTransfer: 0, tx: 'r1', block: 400 },
    ];

    const curve = new PriceCurve(trades);
    priceTransfers(transfers, curve);
    const ledgers = buildLedgers(trades, transfers, curve, 0.0001);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };

    const relays = findSupplyRelays(transfers, ledgers, ctx);
    expect(relays).toHaveLength(1);

    const relay = relays[0]!;
    expect(relay.source).toBe('source');
    expect(relay.sink).toBe('sink');
    expect(relay.sourceEntryTier).toBe('floor');
    expect(relay.relaySupplyPct).toBeCloseTo(5, 1);
    expect(relay.sinkSellRatio).toBeCloseTo(1, 2);
    expect(relay.suspicion).toBeGreaterThan(70);
    expect(relay.flags.join(' ')).toContain('never bought');
    // The source shows no sells of its own, which is the point of the pattern.
    expect(relay.sourceLedger.sellCount).toBe(0);
    expect(relay.combinedTakeUsd).toBeGreaterThan(4_000);
  });

  it('ignores a relay whose sink never sold', () => {
    const trades = [
      trade({ ts: 100, wallet: 'source', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
    ];
    const transfers: SupplyTransfer[] = [
      { ts: 400, from: 'source', to: 'holder', tokenAmount: 50_000_000, usdAtTransfer: 0, tx: 'r1', block: 400 },
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, transfers, curve, 0.000002);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };
    expect(findSupplyRelays(transfers, ledgers, ctx)).toHaveLength(0);
  });
});

describe('minPositionUsd', () => {
  it('scales the bar with the coin instead of using a flat dollar amount', () => {
    // Floor $9.1k (PEPE): 0.05% is under the absolute sanity floor, so a $55
    // launch buy — a real early position — survives.
    expect(minPositionUsd(9_110)).toBeCloseTo(5, 6);
    // Floor $1.4M (BRETT): the same $55 is dust and gets filtered.
    expect(minPositionUsd(1_400_000)).toBeCloseTo(700, 6);
    // Floor $40M: proportionally larger again.
    expect(minPositionUsd(40_000_000)).toBeCloseTo(20_000, 6);
  });

  it('never drops below the absolute sanity floor', () => {
    expect(minPositionUsd(0)).toBeCloseTo(5, 6);
    expect(minPositionUsd(100)).toBeCloseTo(5, 6);
  });
});

describe('position filtering', () => {
  it('keeps a small launch buy on a low-floor coin', () => {
    // $55 at a $9.1k floor is ~0.6% of the whole coin. The old flat $50 bar
    // filtered these out; they are exactly who this bot is looking for.
    const trades = [
      trade({ ts: 100, wallet: 'tiny', side: 'buy', tokenAmount: 6_000_000, priceUsd: 0.00000911 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.00000911);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };
    expect(ledgers.get('tiny')!.totalBoughtUsd).toBeCloseTo(54.66, 1);
    expect(findEarlyBuyers(ledgers, ctx).map((e) => e.ledger.wallet)).toEqual(['tiny']);
  });

  it('filters the same dollar amount out on a high-floor coin', () => {
    // Same ~$55, but the coin's floor is $1.4M, so it is genuine dust.
    const trades = [
      trade({ ts: 100, wallet: 'dust', side: 'buy', tokenAmount: 39, priceUsd: 0.0014 }),
      trade({ ts: 110, wallet: 'real', side: 'buy', tokenAmount: 2_000_000, priceUsd: 0.0014 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0014);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };
    expect(curve.floorMcap).toBeCloseTo(1_400_000, 0);
    const wallets = findEarlyBuyers(ledgers, ctx).map((e) => e.ledger.wallet);
    expect(wallets).toContain('real');
    expect(wallets).not.toContain('dust');
  });
});

describe('findEarlyBuyers', () => {
  it('ranks entry order across all buyers, not just the filtered ones', () => {
    const trades = [
      trade({ ts: 100, wallet: 'first', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 110, wallet: 'second', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.0000021 }),
      trade({ ts: 900, wallet: 'latecomer', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.0002 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0002);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };

    const early = findEarlyBuyers(ledgers, ctx);
    expect(early.map((e) => e.ledger.wallet)).toEqual(['first', 'second']);
    expect(early[0]!.entryRank).toBe(1);
    expect(early[1]!.entryRank).toBe(2);
    expect(early[1]!.secondsAfterLaunch).toBe(10);
    expect(early[0]!.supplyPct).toBeCloseTo(5, 3);
  });
});

describe('rent-artifact and floor regressions (live-data bugs)', () => {
  it('keeps the true minimum when many trades share one second', () => {
    // Solana packs trades into the same second. Collapsing them to the highest
    // print reported a floor ABOVE market caps wallets had actually bought at.
    const trades = [
      trade({ ts: 100, wallet: 'a', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.000025 }),
      trade({ ts: 100, wallet: 'b', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.0000203 }),
      trade({ ts: 100, wallet: 'c', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.000030 }),
    ];
    const curve = new PriceCurve(trades);
    // 0.0000203 * 1e9 supply = $20,300 — the lowest print, not the highest.
    expect(curve.floorMcap).toBeCloseTo(20_300, 0);
    expect(curve.peakMcap).toBeCloseTo(30_000, 0);
  });

  it('never reports an entry below the floor', () => {
    const trades = [
      trade({ ts: 100, wallet: 'hi', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.000030 }),
      trade({ ts: 100, wallet: 'lo', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.0000203 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.000025);
    for (const l of ledgers.values()) {
      expect(l.entryMcap).toBeGreaterThanOrEqual(curve.floorMcap);
    }
  });

  it('peak window starts at the first sample in range, not the last before it', () => {
    const trades = [
      trade({ ts: 100, wallet: 'x', side: 'buy', tokenAmount: 1000, priceUsd: 0.001 }),
      trade({ ts: 100, wallet: 'y', side: 'buy', tokenAmount: 1000, priceUsd: 0.005 }),
      trade({ ts: 200, wallet: 'z', side: 'buy', tokenAmount: 1000, priceUsd: 0.002 }),
    ];
    const curve = new PriceCurve(trades);
    // Window [100,200] must see the 0.005 print that shares ts=100.
    expect(curve.peak(100, 200)).toBeCloseTo(0.005 * SUPPLY, 0);
  });

  it('excludes a same-second flipper from diamond hands', () => {
    // Bought and sold 2s apart while the price spiked around it. Held nothing.
    const trades = [
      trade({ ts: 100, wallet: 'flip', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.00002 }),
      trade({ ts: 101, wallet: 'other', side: 'buy', tokenAmount: 10, priceUsd: 0.005 }),
      trade({ ts: 102, wallet: 'flip', side: 'sell', tokenAmount: 1_000_000, priceUsd: 0.0000202 }),
      trade({ ts: 400, wallet: 'held', side: 'buy', tokenAmount: 1_000_000, priceUsd: 0.00002 }),
      trade({ ts: 9000, wallet: 'held', side: 'sell', tokenAmount: 1_000_000, priceUsd: 0.0002 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0002);
    const ctx = {
      floorMcap: curve.floorMcap,
      floorBandMax: curve.floorMcap * 1.75,
      firstTradeTs: 100,
      totalSupply: SUPPLY,
    };
    const wallets = findDiamondHands(ledgers, ctx).map((d) => d.ledger.wallet);
    expect(wallets).not.toContain('flip');
    expect(wallets).toContain('held');
  });
});

describe('cost basis is consumed as it is sold', () => {
  it('does not re-charge basis against free tokens after a full exit', () => {
    // Bought 100 @ $1, sold all 100 @ $2, then was handed 50 free tokens.
    // Those 50 cost nothing — the basis was already used up by the sale.
    const trades = [
      trade({ ts: 100, wallet: 'w', side: 'buy', tokenAmount: 100, priceUsd: 1 }),
      trade({ ts: 200, wallet: 'w', side: 'sell', tokenAmount: 100, priceUsd: 2 }),
    ];
    const transfers = [
      { ts: 300, from: 'giver', to: 'w', tokenAmount: 50, usdAtTransfer: 0, tx: 't1', block: 3 },
    ];
    const curve = new PriceCurve(trades);
    const l = buildLedgers(trades, transfers, curve, 2).get('w')!;

    expect(l.realizedUsd).toBeCloseTo(100, 6);
    // 50 free tokens at $2, with no basis left to deduct.
    expect(l.unrealizedUsd).toBeCloseTo(100, 6);
    expect(l.totalPnlUsd).toBeCloseTo(200, 6);
  });

  it('still deducts basis for a partially sold position', () => {
    // Bought 100 @ $1, sold 50 @ $2. The other 50 keep their $1 basis.
    const trades = [
      trade({ ts: 100, wallet: 'w', side: 'buy', tokenAmount: 100, priceUsd: 1 }),
      trade({ ts: 200, wallet: 'w', side: 'sell', tokenAmount: 50, priceUsd: 2 }),
    ];
    const curve = new PriceCurve(trades);
    const l = buildLedgers(trades, [], curve, 2).get('w')!;

    expect(l.realizedUsd).toBeCloseTo(50, 6);
    expect(l.unrealizedUsd).toBeCloseTo(50, 6);
    expect(l.totalPnlUsd).toBeCloseTo(100, 6);
  });

  it('treats a pure recipient as all-profit', () => {
    // Never bought; only received and sold. Nothing to deduct.
    const trades = [
      trade({ ts: 100, wallet: 'buyer', side: 'buy', tokenAmount: 100, priceUsd: 1 }),
      trade({ ts: 300, wallet: 'sink', side: 'sell', tokenAmount: 40, priceUsd: 2 }),
    ];
    const transfers = [
      { ts: 200, from: 'buyer', to: 'sink', tokenAmount: 50, usdAtTransfer: 0, tx: 't1', block: 2 },
    ];
    const curve = new PriceCurve(trades);
    const l = buildLedgers(trades, transfers, curve, 2).get('sink')!;

    expect(l.totalBoughtUsd).toBe(0);
    expect(l.realizedUsd).toBeCloseTo(80, 6);
    expect(l.balanceTokens).toBeCloseTo(10, 6);
    expect(l.unrealizedUsd).toBeCloseTo(20, 6);
  });
});

describe('relay attribution is proportional', () => {
  const ctx = { floorMcap: 2000, floorBandMax: 3500, firstTradeTs: 100, totalSupply: SUPPLY };

  it('does not credit the sink\'s own sells to the relay', () => {
    // Sink bought 3M itself and was relayed 1M, so only a quarter of its
    // selling can be attributed to this relay.
    const trades = [
      trade({ ts: 100, wallet: 'src', side: 'buy', tokenAmount: 20_000_000, priceUsd: 0.000002 }),
      trade({ ts: 150, wallet: 'sink', side: 'buy', tokenAmount: 3_000_000, priceUsd: 0.000002 }),
      trade({ ts: 400, wallet: 'sink', side: 'sell', tokenAmount: 4_000_000, priceUsd: 0.00002 }),
    ];
    const transfers = [
      { ts: 300, from: 'src', to: 'sink', tokenAmount: 1_000_000, usdAtTransfer: 0, tx: 't1', block: 3 },
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, transfers, curve, 0.00002);
    const relays = findSupplyRelays(transfers, ledgers, ctx);

    expect(relays).toHaveLength(1);
    // Sink realised $80 across 4M acquired; 1M of that came from the relay,
    // so $20 is attributable — not the full $80.
    expect(relays[0]!.sinkSoldUsd).toBeCloseTo(20, 1);
  });

  it('attributes fully when the sink only ever held relayed supply', () => {
    const trades = [
      trade({ ts: 100, wallet: 'src', side: 'buy', tokenAmount: 20_000_000, priceUsd: 0.000002 }),
      trade({ ts: 400, wallet: 'sink', side: 'sell', tokenAmount: 950_000, priceUsd: 0.00002 }),
    ];
    const transfers = [
      { ts: 300, from: 'src', to: 'sink', tokenAmount: 1_000_000, usdAtTransfer: 0, tx: 't1', block: 3 },
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, transfers, curve, 0.00002);
    const relays = findSupplyRelays(transfers, ledgers, ctx);

    expect(relays).toHaveLength(1);
    expect(relays[0]!.sinkSellRatio).toBeCloseTo(0.95, 2);
    expect(relays[0]!.sinkSoldUsd).toBeCloseTo(19, 1);
    expect(relays[0]!.flags.some((f) => f.includes('never bought'))).toBe(true);
  });

  it('demotes a high fan-in address as a likely exchange deposit', () => {
    const trades = [
      trade({ ts: 100, wallet: 'src', side: 'buy', tokenAmount: 20_000_000, priceUsd: 0.000002 }),
      trade({ ts: 400, wallet: 'cex', side: 'sell', tokenAmount: 950_000, priceUsd: 0.00002 }),
    ];
    const transfers = [
      { ts: 300, from: 'src', to: 'cex', tokenAmount: 1_000_000, usdAtTransfer: 0, tx: 't1', block: 3 },
      ...['a', 'b', 'c', 'd', 'e'].map((w, i) => ({
        ts: 310 + i,
        from: w,
        to: 'cex',
        tokenAmount: 5_000,
        usdAtTransfer: 0,
        tx: `t${i + 2}`,
        block: 4 + i,
      })),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, transfers, curve, 0.00002);
    const relays = findSupplyRelays(transfers, ledgers, ctx);

    expect(relays).toHaveLength(1);
    expect(relays[0]!.flags.some((f) => f.includes('CEX'))).toBe(true);
    // Demoted below the "strong relay" bar the overview and risk score use,
    // but not dropped — a deposit address is still an exit.
    expect(relays[0]!.suspicion).toBeLessThan(60);
  });
});

describe('peak never reports a price from outside the window', () => {
  it('returns nothing when the trade window does not overlap the query', () => {
    // Trades from "today"; the wallet held months earlier. Falling back to the
    // nearest known price credited a 40-second hold with 4595x.
    const trades = [
      trade({ ts: 1_000_000, wallet: 'w', side: 'buy', tokenAmount: 1000, priceUsd: 0.01 }),
      trade({ ts: 1_000_100, wallet: 'w', side: 'sell', tokenAmount: 1000, priceUsd: 0.012 }),
    ];
    const curve = new PriceCurve(trades);
    // A window entirely before the trade coverage.
    expect(curve.peak(500, 600)).toBe(0);
    // And entirely after.
    expect(curve.peak(2_000_000, 2_000_100)).toBe(0);
  });

  it('still answers windows that do overlap', () => {
    const trades = [
      trade({ ts: 1_000, wallet: 'w', side: 'buy', tokenAmount: 1000, priceUsd: 0.001 }),
      trade({ ts: 2_000, wallet: 'w', side: 'buy', tokenAmount: 1000, priceUsd: 0.005 }),
      trade({ ts: 3_000, wallet: 'w', side: 'buy', tokenAmount: 1000, priceUsd: 0.002 }),
    ];
    const curve = new PriceCurve(trades);
    expect(curve.peak(1_000, 3_000)).toBeCloseTo(0.005 * SUPPLY, 0);
    // Partial overlap is fine — it uses the samples that are inside.
    expect(curve.peak(500, 2_000)).toBeCloseTo(0.005 * SUPPLY, 0);
  });
});

describe('infrastructure is never mistaken for a wallet', () => {
  const ctx = { floorMcap: 2_000, floorBandMax: 3_500, firstTradeTs: 100, totalSupply: SUPPLY };

  function relaySetup(sink: string) {
    const trades = [
      trade({ ts: 100, wallet: 'source', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 500, wallet: sink, side: 'sell', tokenAmount: 50_000_000, priceUsd: 0.0001 }),
    ];
    const transfers: SupplyTransfer[] = [
      { ts: 400, from: 'source', to: sink, tokenAmount: 50_000_000, usdAtTransfer: 0, tx: 'r1', block: 400 },
    ];
    const curve = new PriceCurve(trades);
    priceTransfers(transfers, curve);
    return { transfers, ledgers: buildLedgers(trades, transfers, curve, 0.0001) };
  }

  it('drops a relay whose sink is a burn address', () => {
    const { transfers, ledgers } = relaySetup('0x000000000000000000000000000000000000dead');
    expect(findSupplyRelays(transfers, ledgers, ctx, 'ethereum')).toHaveLength(0);
  });

  it('keeps an exchange deposit but calls it what it is', () => {
    const cex = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
    const { transfers, ledgers } = relaySetup(cex);
    const relays = findSupplyRelays(transfers, ledgers, ctx, 'solana');

    expect(relays).toHaveLength(1);
    expect(relays[0]!.flags.join(' ')).toContain('Binance');
    // Named with certainty, so it must not score as a covert exit wallet.
    expect(relays[0]!.suspicion).toBeLessThan(40);
  });

  it('still flags an unknown second wallet at full strength', () => {
    const { transfers, ledgers } = relaySetup('SomeRandomSecondWallet1111111111111111111111');
    const relays = findSupplyRelays(transfers, ledgers, ctx, 'solana');
    expect(relays[0]!.suspicion).toBeGreaterThan(70);
  });
});

describe('entry band rebases when the floor was a sell', () => {
  it('does not rebase when buyers reach the floor', () => {
    const trades = [
      trade({ ts: 100, wallet: 'a', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.000002 }),
      trade({ ts: 200, wallet: 'b', side: 'buy', tokenAmount: 50_000_000, priceUsd: 0.00002 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.00002);
    const ctx = { floorMcap: curve.floorMcap, floorBandMax: curve.floorMcap * 1.75, firstTradeTs: 100, totalSupply: SUPPLY };
    expect(resolveEntryBand(ledgers, ctx).rebased).toBe(false);
  });

  it('rebases onto the lowest real buy when the floor print was a sell', () => {
    // Mirrors $NAILONG: opening sell at $7.4k, lowest actual buy at $19.8k.
    const trades = [
      trade({ ts: 100, wallet: 'seller', side: 'sell', tokenAmount: 10_000_000, priceUsd: 0.0000074 }),
      trade({ ts: 200, wallet: 'buyer1', side: 'buy', tokenAmount: 10_000_000, priceUsd: 0.0000198 }),
      trade({ ts: 300, wallet: 'buyer2', side: 'buy', tokenAmount: 10_000_000, priceUsd: 0.0000205 }),
      trade({ ts: 400, wallet: 'late', side: 'buy', tokenAmount: 10_000_000, priceUsd: 0.0002 }),
    ];
    const curve = new PriceCurve(trades);
    const ledgers = buildLedgers(trades, [], curve, 0.0002);
    const ctx = { floorMcap: curve.floorMcap, floorBandMax: curve.floorMcap * 1.75, firstTradeTs: 100, totalSupply: SUPPLY };

    // Raw floor is the sell; no buyer is anywhere near it.
    expect(curve.floorMcap).toBeCloseTo(7_400, 0);

    const band = resolveEntryBand(ledgers, ctx);
    expect(band.rebased).toBe(true);
    expect(band.floorMcap).toBeCloseTo(19_800, 0);

    // And the early-buyer list is no longer empty.
    const wallets = findEarlyBuyers(ledgers, ctx).map((e) => e.ledger.wallet);
    expect(wallets).toContain('buyer1');
    expect(wallets).toContain('buyer2');
    expect(wallets).not.toContain('late');
  });
});

describe('supply share reflects the position held, not cumulative buying', () => {
  const W = 'churner';
  const t = (side: 'buy' | 'sell', tokenAmount: number, ts: number) =>
    trade({ ts, wallet: W, side, tokenAmount, priceUsd: 0.000002 });
  const curve = new PriceCurve([t('buy', 1000, 1)]);

  it('never counts the same tokens twice for a wallet that churns', () => {
    // An arb bot cycling 400 tokens four times bought 1,600 but never held more
    // than 400. Reporting the cumulative figure as "% supply" is how a wallet
    // came to be credited with 170.51% of a coin.
    const trades = [];
    for (let i = 0; i < 4; i++) {
      trades.push(t('buy', 400, i * 10 + 1), t('sell', 400, i * 10 + 2));
    }
    const l = buildLedgers(trades, [], curve, 0.000002).get(W)!;
    expect(l.totalBoughtTokens).toBe(1600);
    expect(l.peakTokens).toBe(400);
  });

  it('measures the largest position, not the last one', () => {
    const l = buildLedgers([t('buy', 900, 1), t('sell', 800, 2), t('buy', 50, 3)], [], curve, 0.000002).get(W)!;
    expect(l.peakTokens).toBe(900);
  });

  it('matches total bought when a wallet only accumulates', () => {
    const l = buildLedgers([t('buy', 300, 1), t('buy', 200, 2)], [], curve, 0.000002).get(W)!;
    expect(l.peakTokens).toBe(500);
  });
});

describe('addresses that cannot be holders', () => {
  const W = 'router';
  const t = (side: 'buy' | 'sell', tokenAmount: number, ts: number) =>
    trade({ ts, wallet: W, side, tokenAmount, priceUsd: 0.000002 });
  const curve = new PriceCurve([t('buy', 1000, 1)]);

  it('a router accumulates a position larger than the supply exists', () => {
    // Nobody can hold more of a token than exists, so this is the signal that
    // an address is something tokens pass THROUGH. One such router was ranked
    // the second-best floor entry on a coin at 153% of supply and 91x, because
    // every trader's volume routed through it. Checking the property rather
    // than a list catches the routers nobody has catalogued yet.
    const trades = [];
    for (let i = 0; i < 5; i++) trades.push(t('buy', SUPPLY / 2, i * 10 + 1));
    const l = buildLedgers(trades, [], curve, 0.000002).get(W)!;
    expect(l.peakTokens).toBeGreaterThan(SUPPLY);
  });

  it('leaves a wallet holding almost all of the supply alone', () => {
    // A dev holding 99% is unusual, not impossible — the test is strictly ">".
    const l = buildLedgers([t('buy', SUPPLY * 0.99, 1)], [], curve, 0.000002).get(W)!;
    expect(l.peakTokens).toBeLessThan(SUPPLY);
  });
});
