import { describe, it, expect } from 'vitest';
import {
  classifyPlay,
  rankPlays,
  entryDelay,
  holdSeconds,
  fromFirstBuyer,
  fromLedger,
  type PlayInput,
} from '../src/engine/winningPlay.js';
import type { FirstBuyer } from '../src/data/solanatracker.js';
import type { WalletLedger } from '../src/types/domain.js';

const LAUNCH = 1_700_000_000;

function buyer(over: Partial<PlayInput> = {}): PlayInput {
  return {
    wallet: 'W',
    firstBuyTs: LAUNCH + 60,
    firstSellTs: LAUNCH + 120,
    lastActivityTs: LAUNCH + 120,
    investedUsd: 100,
    profitUsd: 400,
    buyCount: 1,
    sellCount: 1,
    stillHolding: false,
    ...over,
  };
}

describe('entry timing', () => {
  it('measures the delay from launch', () => {
    expect(entryDelay(buyer({ firstBuyTs: LAUNCH + 900 }), LAUNCH)).toBe(900);
  });

  it('treats a pre-launch buy as a snipe rather than guessing', () => {
    // Migrated coins report the pool's creation, not the token's, so the
    // first buy can legitimately precede it.
    expect(entryDelay(buyer({ firstBuyTs: LAUNCH - 500 }), LAUNCH)).toBe(0);
  });

  it('is unknown without a launch time', () => {
    expect(entryDelay(buyer(), null)).toBeNull();
  });
});

describe('hold time', () => {
  it('runs from first buy to first sell', () => {
    expect(holdSeconds(buyer({ firstBuyTs: LAUNCH, firstSellTs: LAUNCH + 300 }))).toBe(300);
  });

  it('falls back to last activity when they never sold', () => {
    expect(
      holdSeconds(buyer({ firstBuyTs: LAUNCH, firstSellTs: null, lastActivityTs: LAUNCH + 900 })),
    ).toBe(900);
  });
});

describe('hold time for a wallet still holding', () => {
  it('runs to last activity, not to an early trim', () => {
    // Selling a sliver 7s in and keeping the rest is not a 7-second hold; that
    // bug made the screen report "sat on it, held 7s".
    const b = buyer({
      firstBuyTs: LAUNCH,
      firstSellTs: LAUNCH + 7,
      lastActivityTs: LAUNCH + 90_000,
      stillHolding: true,
    });
    expect(holdSeconds(b)).toBe(90_000);
  });

  it('still uses the first sell for a wallet that exited', () => {
    const b = buyer({
      firstBuyTs: LAUNCH,
      firstSellTs: LAUNCH + 7,
      lastActivityTs: LAUNCH + 90_000,
      stillHolding: false,
    });
    expect(holdSeconds(b)).toBe(7);
  });
});

describe('play classification', () => {
  it('calls a fast in-and-out at launch a snipe flip', () => {
    expect(classifyPlay(buyer(), LAUNCH)).toBe('snipe-flip');
  });

  it('calls an early entry held through the run a snipe hold', () => {
    const b = buyer({ firstSellTs: LAUNCH + 40_000, lastActivityTs: LAUNCH + 40_000 });
    expect(classifyPlay(b, LAUNCH)).toBe('snipe-hold');
  });

  it('keeps a still-holding sniper out of the flip bucket', () => {
    // Selling a slice fast does not make it a flip if most is still held.
    const b = buyer({ stillHolding: true });
    expect(classifyPlay(b, LAUNCH)).toBe('snipe-hold');
  });

  it('recognises a scaled position regardless of timing', () => {
    const b = buyer({ buyCount: 5, sellCount: 4, firstBuyTs: LAUNCH + 50_000 });
    expect(classifyPlay(b, LAUNCH)).toBe('scale-trim');
  });

  it('separates a late quick flip from a late hold', () => {
    const late = { firstBuyTs: LAUNCH + 200_000 };
    expect(classifyPlay(buyer({ ...late, firstSellTs: LAUNCH + 200_060 }), LAUNCH)).toBe(
      'momentum-flip',
    );
    expect(
      classifyPlay(
        buyer({ ...late, firstSellTs: null, lastActivityTs: LAUNCH + 400_000, stillHolding: true }),
        LAUNCH,
      ),
    ).toBe('late-hold');
  });

  it('refuses to classify without a launch time', () => {
    expect(classifyPlay(buyer(), null)).toBeNull();
  });
});

describe('ranking what worked', () => {
  it('ranks by profit, not by how many wallets did it', () => {
    // The popular play and the profitable one are usually different.
    const many = Array.from({ length: 8 }, (_, i) =>
      buyer({ wallet: `flip${i}`, profitUsd: 400 }),
    );
    const few = [
      buyer({ wallet: 'hold1', profitUsd: 20_000, firstSellTs: LAUNCH + 90_000, lastActivityTs: LAUNCH + 90_000 }),
    ];
    const plays = rankPlays([...many, ...few], LAUNCH);
    expect(plays[0]!.kind).toBe('snipe-hold');
    expect(plays[0]!.wallets).toBe(1);
    expect(plays[1]!.wallets).toBe(8);
  });

  it('ignores wallets that did not make money', () => {
    const plays = rankPlays([buyer({ profitUsd: 12 }), buyer({ profitUsd: -500 })], LAUNCH);
    expect(plays).toHaveLength(0);
  });

  it('reports a median multiple that one outlier cannot move', () => {
    // Amounts stay above the profit floor so all five are actually counted.
    const members = [4, 4, 4, 4, 100].map((m, i) =>
      buyer({ wallet: `w${i}`, investedUsd: 100, profitUsd: m * 100 }),
    );
    expect(rankPlays(members, LAUNCH)[0]!.medianMultiple).toBe(5);
  });

  it('names the best wallet in each group', () => {
    const plays = rankPlays(
      [buyer({ wallet: 'small', profitUsd: 400 }), buyer({ wallet: 'big', profitUsd: 9000 })],
      LAUNCH,
    );
    expect(plays[0]!.bestWallet).toBe('big');
    expect(plays[0]!.bestProfitUsd).toBe(9000);
  });
});


describe('both sources map onto the same input', () => {
  it('reads a Solana first-buyer record', () => {
    const b = {
      wallet: 'S',
      firstBuyTs: LAUNCH,
      firstSellTs: LAUNCH + 30,
      lastActivityTs: LAUNCH + 30,
      heldTokens: 1000,
      holdingTokens: 500,
      totalInvestedUsd: 250,
      totalPnlUsd: 900,
      buyCount: 2,
      sellCount: 1,
    } as FirstBuyer;
    const p = fromFirstBuyer(b);
    expect(p).toMatchObject({ wallet: 'S', investedUsd: 250, profitUsd: 900, stillHolding: true });
  });

  it('treats a dusted-out provider record as exited', () => {
    // A 0.1% remainder is dust left behind by a full exit, not a position.
    const b = { heldTokens: 1000, holdingTokens: 1, totalInvestedUsd: 1 } as FirstBuyer;
    expect(fromFirstBuyer(b).stillHolding).toBe(false);
  });

  it('reads an EVM replay ledger', () => {
    // EVM has no provider for this, so the replay is the only source.
    const l = {
      wallet: '0xabc',
      firstBuyTs: LAUNCH,
      firstSellTs: null,
      lastActivityTs: LAUNCH + 4000,
      totalBoughtUsd: 500,
      totalPnlUsd: 2500,
      buyCount: 3,
      sellCount: 0,
      stillHolding: true,
    } as WalletLedger;
    const p = fromLedger(l);
    expect(p).toMatchObject({ wallet: '0xabc', investedUsd: 500, profitUsd: 2500, stillHolding: true });
    expect(classifyPlay(p, LAUNCH)).toBe('snipe-hold');
  });

  it('nulls a ledger timestamp of zero rather than reading it as 1970', () => {
    const l = { wallet: '0x1', firstBuyTs: 0, lastActivityTs: 0, firstSellTs: null } as WalletLedger;
    expect(fromLedger(l).firstBuyTs).toBeNull();
    expect(entryDelay(fromLedger(l), LAUNCH)).toBeNull();
  });
});
