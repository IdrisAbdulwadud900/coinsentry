import { describe, it, expect } from 'vitest';
import { classifyPlay, rankPlays, entryDelay, holdSeconds } from '../src/engine/winningPlay.js';
import type { FirstBuyer } from '../src/data/solanatracker.js';

const LAUNCH = 1_700_000_000;

function buyer(over: Partial<FirstBuyer> = {}): FirstBuyer {
  return {
    wallet: 'W',
    entryTokens: 1000,
    entryUsd: 100,
    firstBuyTs: LAUNCH + 60,
    firstSellTs: LAUNCH + 120,
    lastActivityTs: LAUNCH + 120,
    heldTokens: 1000,
    holdingTokens: 0,
    soldTokens: 1000,
    totalInvestedUsd: 100,
    totalSoldUsd: 500,
    realizedUsd: 400,
    unrealizedUsd: 0,
    totalPnlUsd: 400,
    costBasisUsd: 0.1,
    buyCount: 1,
    sellCount: 1,
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
      holdingTokens: 950,
      heldTokens: 1000,
    });
    expect(holdSeconds(b)).toBe(90_000);
  });

  it('still uses the first sell for a wallet that exited', () => {
    const b = buyer({
      firstBuyTs: LAUNCH,
      firstSellTs: LAUNCH + 7,
      lastActivityTs: LAUNCH + 90_000,
      holdingTokens: 0,
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
    const b = buyer({ holdingTokens: 900, heldTokens: 1000 });
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
        buyer({ ...late, firstSellTs: null, lastActivityTs: LAUNCH + 400_000, holdingTokens: 900 }),
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
      buyer({ wallet: `flip${i}`, totalPnlUsd: 400 }),
    );
    const few = [
      buyer({ wallet: 'hold1', totalPnlUsd: 20_000, firstSellTs: LAUNCH + 90_000, lastActivityTs: LAUNCH + 90_000 }),
    ];
    const plays = rankPlays([...many, ...few], LAUNCH);
    expect(plays[0]!.kind).toBe('snipe-hold');
    expect(plays[0]!.wallets).toBe(1);
    expect(plays[1]!.wallets).toBe(8);
  });

  it('ignores wallets that did not make money', () => {
    const plays = rankPlays([buyer({ totalPnlUsd: 12 }), buyer({ totalPnlUsd: -500 })], LAUNCH);
    expect(plays).toHaveLength(0);
  });

  it('reports a median multiple that one outlier cannot move', () => {
    // Amounts stay above the profit floor so all five are actually counted.
    const members = [4, 4, 4, 4, 100].map((m, i) =>
      buyer({ wallet: `w${i}`, totalInvestedUsd: 100, totalPnlUsd: m * 100 }),
    );
    expect(rankPlays(members, LAUNCH)[0]!.medianMultiple).toBe(5);
  });

  it('names the best wallet in each group', () => {
    const plays = rankPlays(
      [buyer({ wallet: 'small', totalPnlUsd: 400 }), buyer({ wallet: 'big', totalPnlUsd: 9000 })],
      LAUNCH,
    );
    expect(plays[0]!.bestWallet).toBe('big');
    expect(plays[0]!.bestProfitUsd).toBe(9000);
  });
});
