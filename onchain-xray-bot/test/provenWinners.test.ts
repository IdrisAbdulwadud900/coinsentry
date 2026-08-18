import { describe, it, expect } from 'vitest';
import { isQualifyingWin, qualifiesOnThisCoin, buildWinner, rankWinners } from '../src/engine/provenWinners.js';
import type { FirstBuyer, TokenResult } from '../src/data/solanatracker.js';

const MINT = 'ThisCoin1111111111111111111111111111111111';

const result = (over: Partial<TokenResult> = {}): TokenResult => ({
  mint: 'Other111', profitUsd: 500, investedUsd: 100, multiple: 6,
  holdingUsd: 0, firstBuyTs: 1000, ...over,
});

const trader = (over: Partial<FirstBuyer> = {}): FirstBuyer => ({
  wallet: 'W1', entryTokens: 1000, entryUsd: 100,
  firstBuyTs: 1000, firstSellTs: 5000, lastActivityTs: 5000,
  heldTokens: 1000, holdingTokens: 0, soldTokens: 1000,
  totalInvestedUsd: 200, totalSoldUsd: 1000, realizedUsd: 800,
  unrealizedUsd: 0, totalPnlUsd: 800, costBasisUsd: 0.1,
  buyCount: 2, sellCount: 1, ...over,
});

describe('a win must clear profit, multiple AND size', () => {
  it('accepts a real win', () => {
    expect(isQualifyingWin(result({ profitUsd: 500, multiple: 6, investedUsd: 100 }))).toBe(true);
  });

  it('rejects a big percentage on a trivial stake', () => {
    // $10 turned into $40 is 4x, but it is not a result worth copying.
    expect(isQualifyingWin(result({ profitUsd: 30, multiple: 4, investedUsd: 10 }))).toBe(false);
  });

  it('rejects a big profit that took a huge stake', () => {
    // $300 on $30,000 is a 1.01x — not the same skill as $300 on $100.
    expect(isQualifyingWin(result({ profitUsd: 300, multiple: 1.01, investedUsd: 30_000 }))).toBe(false);
  });

  it('rejects a loss and a break-even', () => {
    expect(isQualifyingWin(result({ profitUsd: -500, multiple: 0.2 }))).toBe(false);
    expect(isQualifyingWin(result({ profitUsd: 0, multiple: 1 }))).toBe(false);
  });
});

describe('qualifying on the analysed coin', () => {
  it('accepts $800 profit on $200 (5x)', () => {
    expect(qualifiesOnThisCoin(trader())).toBe(true);
  });

  it('rejects a wallet that made money without tripling', () => {
    expect(qualifiesOnThisCoin(trader({ totalInvestedUsd: 10_000, totalPnlUsd: 400 }))).toBe(false);
  });

  it('rejects a wallet under the profit floor', () => {
    expect(qualifiesOnThisCoin(trader({ totalInvestedUsd: 20, totalPnlUsd: 100 }))).toBe(false);
  });
});

describe('repeat record', () => {
  it('counts other coins won the same way', () => {
    const w = buildWinner(trader(), [
      result({ mint: 'A', profitUsd: 900, multiple: 9 }),
      result({ mint: 'B', profitUsd: 400, multiple: 4 }),
      result({ mint: 'C', profitUsd: 20, multiple: 1.2 }),   // too small
      result({ mint: 'D', profitUsd: -800, multiple: 0.1 }), // a loss
    ], MINT);
    expect(w.repeatWins).toBe(2);
    expect(w.repeatProfitUsd).toBeCloseTo(1300, 6);
    expect(w.bestOtherMultiple).toBeCloseTo(9, 6);
    expect(w.coinsTraded).toBe(4);
  });

  it('never lets the analysed coin vouch for itself', () => {
    // Without excluding it, every trader would start with a free win.
    const w = buildWinner(trader(), [result({ mint: MINT, profitUsd: 5000, multiple: 20 })], MINT);
    expect(w.repeatWins).toBe(0);
  });

  it('drops wallets below the repeat bar', () => {
    const oneHit = buildWinner(trader(), [result({ mint: 'A' })], MINT);
    expect(rankWinners([oneHit])).toHaveLength(0);
  });

  it('ranks repeatability above size on this coin', () => {
    // A wallet that has done this eight times is the better bet, even if
    // someone else made more on this single token.
    const bigOnce = buildWinner(
      trader({ wallet: 'BIG', totalPnlUsd: 100_000, totalInvestedUsd: 1_000 }),
      Array.from({ length: 3 }, (_, i) => result({ mint: `x${i}`, profitUsd: 400 })),
      MINT,
    );
    const steady = buildWinner(
      trader({ wallet: 'STEADY', totalPnlUsd: 900, totalInvestedUsd: 200 }),
      Array.from({ length: 8 }, (_, i) => result({ mint: `y${i}`, profitUsd: 600 })),
      MINT,
    );
    expect(rankWinners([bigOnce, steady])[0]!.wallet).toBe('STEADY');
  });

  it('handles a wallet with no other history', () => {
    const w = buildWinner(trader(), [], MINT);
    expect(w.repeatWins).toBe(0);
    expect(w.coinsTraded).toBe(0);
    expect(Number.isFinite(w.multiple)).toBe(true);
  });
});

describe('side wallets link through a SHARED funder', () => {
  const peers = (m: Record<string, number>) =>
    new Map(Object.entries(m).map(([k, sol]) => [k, { sol, sent: false, received: true }]));
  const pair = () => [
    trader({ wallet: 'A', totalPnlUsd: 900, totalInvestedUsd: 200 }),
    trader({ wallet: 'B', totalPnlUsd: 800, totalInvestedUsd: 200 }),
  ];

  it('links two profitable wallets funded by the same address twice', async () => {
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ F1: 2, F2: 1.5 })], ['B', peers({ F1: 2, F2: 1.5 })]]);
    const links = findSideWallets(sets, pair());
    expect(links.get('A')!.map((s) => s.wallet)).toEqual(['B']);
    expect(links.get('A')![0]!.sharedFunders).toBe(2);
  });

  it('rejects a single ordinary shared funder', async () => {
    // One shared counterparty at small size is how bots and relayers look.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ F1: 2 })], ['B', peers({ F1: 2 })]]);
    expect(findSideWallets(sets, pair()).size).toBe(0);
  });

  it('accepts a single shared funder when it sent size to both', async () => {
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ F1: 304 })], ['B', peers({ F1: 303 })]]);
    expect(findSideWallets(sets, pair()).get('A')![0]!.linkedSol).toBe(303);
  });

  it('ignores a dispenser that sent dust to one side', async () => {
    // The real false positive: an address touching many wallets for ~0.1 SOL.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 0.1, F2: 0.2, F3: 0.3 })],
      ['B', peers({ F1: 2.2, F2: 3.1, F3: 1.4 })],
    ]);
    expect(findSideWallets(sets, pair()).size).toBe(0);
  });

  it('drops a linked wallet that did not profit on this coin', async () => {
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const board = [
      trader({ wallet: 'A', totalPnlUsd: 900, totalInvestedUsd: 200 }),
      trader({ wallet: 'B', totalPnlUsd: 5, totalInvestedUsd: 200 }),
    ];
    const sets = new Map([['A', peers({ F1: 2, F2: 2 })], ['B', peers({ F1: 2, F2: 2 })]]);
    // Keyed by anchor: A is offered nothing. B still links to profitable A,
    // but B is never rendered — only proven winners are.
    expect(findSideWallets(sets, board).get('A')).toBeUndefined();
  });

  it('drops a linked wallet absent from the leaderboard', async () => {
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const board = [trader({ wallet: 'A', totalPnlUsd: 900, totalInvestedUsd: 200 })];
    const sets = new Map([['A', peers({ F1: 2, F2: 2 })], ['B', peers({ F1: 2, F2: 2 })]]);
    expect(findSideWallets(sets, board).get('A')).toBeUndefined();
  });

  it('still reports a direct transfer between two winners', async () => {
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ B: 9 })], ['B', new Map()]]);
    const link = findSideWallets(sets, pair()).get('A')![0]!;
    expect(link.direct).toBe(true);
    expect(link.sharedFunders).toBe(0);
  });
});

describe('quietness ordering', () => {
  it('orders by activity and drops wallets that cannot be read', async () => {
    // Loud wallets are unreachable: 300 newest txs cover hours, not months —
    // and worse, that window is shared bot traffic that fakes links.
    const { orderByQuietness } = await import('../src/engine/sideWallets.js');
    const out = orderByQuietness([
      { wallet: 'loud', coinsTraded: 5099 },
      { wallet: 'empty', coinsTraded: 0 },
      { wallet: 'quiet', coinsTraded: 8 },
      { wallet: 'ok', coinsTraded: 254 },
    ]);
    expect(out.map((o) => o.wallet)).toEqual(['quiet', 'ok']);
  });
});

describe('shared services are separated by mirroring, not size', () => {
  const peers = (m: Record<string, number>) =>
    new Map(Object.entries(m).map(([k, sol]) => [k, { sol, sent: false, received: true }]));
  const pair = () => [
    trader({ wallet: 'A', totalPnlUsd: 900, totalInvestedUsd: 200 }),
    trader({ wallet: 'B', totalPnlUsd: 800, totalInvestedUsd: 200 }),
  ];

  it('rejects a terminal that billed each wallet differently', async () => {
    // Real false positive: nine shared peers, none of them matching amounts.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ P1: 14.4, P2: 0.8, P3: 0.5, P4: 0.6, P5: 0.7 })],
      ['B', peers({ P1: 2.7, P2: 1.9, P3: 1.7, P4: 1.2, P5: 2.1 })],
    ]);
    expect(findSideWallets(sets, pair()).size).toBe(0);
  });

  it('accepts small transfers when they match exactly', async () => {
    // Confirmed cluster: 2.0/2.0, 1.5/1.5, 0.5/0.5 — tip-sized but mirrored.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 2.0, F2: 1.5, F3: 0.5 })],
      ['B', peers({ F1: 2.0, F2: 1.5, F3: 0.5 })],
    ]);
    expect(findSideWallets(sets, pair()).get('A')![0]!.sharedFunders).toBe(3);
  });

  it('accepts large near-matching amounts', async () => {
    // Confirmed cluster: 304.8/303.4 and 329.7/489.5.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 304.8, F2: 329.7 })],
      ['B', peers({ F1: 303.4, F2: 489.5 })],
    ]);
    expect(findSideWallets(sets, pair()).get('A')![0]!.sharedFunders).toBe(2);
  });

  it('does not link a pair on one mirrored transfer alone', async () => {
    // A single 2.9/3.2 match was the other half of the false cluster.
    const { findSideWallets } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ P1: 2.9 })], ['B', peers({ P1: 3.2 })]]);
    expect(findSideWallets(sets, pair()).size).toBe(0);
  });
});

describe('clusters group an operator into one finding', () => {
  const peers = (m: Record<string, number>) =>
    new Map(Object.entries(m).map(([k, sol]) => [k, { sol, sent: false, received: true }]));
  const board = ['A', 'B', 'C', 'D'].map((w, i) =>
    trader({ wallet: w, totalPnlUsd: 1000 - i * 10, totalInvestedUsd: 200 }),
  );

  it('merges a chain of pairs into a single group', async () => {
    // A-B and B-C linked separately still means one operator, not two findings.
    const { findSideWallets, buildClusters } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 2, F2: 2 })],
      ['B', peers({ F1: 2, F2: 2, F3: 3, F4: 3 })],
      ['C', peers({ F3: 3, F4: 3 })],
    ]);
    const clusters = buildClusters(findSideWallets(sets, board), board);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((m) => m.wallet).sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps unrelated operators apart and ranks by combined profit', async () => {
    const { findSideWallets, buildClusters } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 2, F2: 2 })],
      ['B', peers({ F1: 2, F2: 2 })],
      ['C', peers({ G1: 5, G2: 5 })],
      ['D', peers({ G1: 5, G2: 5 })],
    ]);
    const clusters = buildClusters(findSideWallets(sets, board), board);
    expect(clusters).toHaveLength(2);
    // A+B (1000+990) outranks C+D (980+970).
    expect(clusters[0]!.members.map((m) => m.wallet).sort()).toEqual(['A', 'B']);
    expect(clusters[0]!.combinedProfitUsd).toBeGreaterThan(clusters[1]!.combinedProfitUsd);
  });

  it('reports the strongest shared-funder count in the group', async () => {
    const { findSideWallets, buildClusters } = await import('../src/engine/sideWallets.js');
    const sets = new Map([
      ['A', peers({ F1: 2, F2: 2 })],
      ['B', peers({ F1: 2, F2: 2, F3: 2, F4: 2, F5: 2 })],
      ['C', peers({ F3: 2, F4: 2, F5: 2 })],
    ]);
    const clusters = buildClusters(findSideWallets(sets, board), board);
    expect(clusters[0]!.sharedFunders).toBe(3);
  });

  it('produces nothing when no pair is linked', async () => {
    const { findSideWallets, buildClusters } = await import('../src/engine/sideWallets.js');
    const sets = new Map([['A', peers({ F1: 2 })], ['B', peers({ G1: 2 })]]);
    expect(buildClusters(findSideWallets(sets, board), board)).toHaveLength(0);
  });
});
