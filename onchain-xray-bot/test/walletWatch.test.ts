import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectBuys,
  detectBuysAcross,
  detectActivity,
  matchesFilter,
  mergeBuysByMint,
} from '../src/engine/walletWatch.js';
import type { HeliusTx } from '../src/data/helius.js';

const W = 'Watched11111111111111111111111111111111111';
const MINT = 'NewCoin111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';

function tx(over: Partial<HeliusTx> = {}): HeliusTx {
  return {
    signature: 'sig1', timestamp: 1_700_000_000, slot: 1, type: 'SWAP',
    source: 'PUMP_FUN', fee: 5_000, feePayer: W,
    accountData: [
      { account: W, nativeBalanceChange: -500_000_000, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'ta', mint: MINT,
          rawTokenAmount: { tokenAmount: '1000000000', decimals: 6 } },
      ] },
    ],
    ...over,
  } as HeliusTx;
}

describe('detectBuys', () => {
  it('reports a token bought with SOL', () => {
    const [buy] = detectBuys(tx(), W);
    expect(buy!.mint).toBe(MINT);
    expect(buy!.tokenAmount).toBeCloseTo(1000, 6);
    // 0.5 SOL out, with the 5,000-lamport fee (0.000005 SOL) added back.
    expect(buy!.solSpent).toBeCloseTo(0.499995, 6);
  });

  it('ignores an inbound token that cost nothing', () => {
    // An airdrop, a transfer in, or an LP withdrawal all increase the balance
    // and say nothing about conviction. Alerting on them would make the feed
    // useless within a day.
    const airdrop = tx({ accountData: [
      { account: W, nativeBalanceChange: 0, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'ta', mint: MINT,
          rawTokenAmount: { tokenAmount: '1000000000', decimals: 6 } },
      ] },
    ] });
    expect(detectBuys(airdrop, W)).toEqual([]);
  });

  it('ignores a sell', () => {
    const sell = tx({ accountData: [
      { account: W, nativeBalanceChange: 500_000_000, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'ta', mint: MINT,
          rawTokenAmount: { tokenAmount: '-1000000000', decimals: 6 } },
      ] },
    ] });
    expect(detectBuys(sell, W)).toEqual([]);
  });

  it('ignores transactions the wallet did not initiate', () => {
    // Appearing as a counterparty is not a decision by this wallet.
    expect(detectBuys(tx({ feePayer: 'SomeoneElse111111111111111111111111111111' }), W)).toEqual([]);
  });

  it('does not treat account rent as a purchase', () => {
    // ~0.00204 SOL of rent must not register as a buy.
    const rent = tx({ accountData: [
      { account: W, nativeBalanceChange: -2_044_280, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'ta', mint: MINT,
          rawTokenAmount: { tokenAmount: '28880000', decimals: 6 } },
      ] },
    ] });
    expect(detectBuys(rent, W)).toEqual([]);
  });

  it('never reports SOL or a stablecoin as the thing bought', () => {
    const wsol = tx({ accountData: [
      { account: W, nativeBalanceChange: -500_000_000, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'ta', mint: SOL,
          rawTokenAmount: { tokenAmount: '1000000000', decimals: 9 } },
      ] },
    ] });
    expect(detectBuys(wsol, W)).toEqual([]);
  });

  it('splits spend across mints when one transaction bought several', () => {
    const multi = tx({ accountData: [
      { account: W, nativeBalanceChange: -1_000_000_000, tokenBalanceChanges: [
        { userAccount: W, tokenAccount: 'a', mint: MINT,
          rawTokenAmount: { tokenAmount: '1000000000', decimals: 6 } },
        { userAccount: W, tokenAccount: 'b', mint: 'Other11111111111111111111111111111111111111',
          rawTokenAmount: { tokenAmount: '2000000000', decimals: 6 } },
      ] },
    ] });
    const buys = detectBuys(multi, W);
    expect(buys).toHaveLength(2);
    expect(buys[0]!.solSpent + buys[1]!.solSpent).toBeCloseTo(0.999995, 6);
  });

  it('skips failed transactions', () => {
    expect(detectBuys(tx({ transactionError: { err: 'x' } }), W)).toEqual([]);
  });

  it('orders results oldest-first so alerts read chronologically', () => {
    const out = detectBuysAcross(
      [tx({ signature: 'new', timestamp: 200 }), tx({ signature: 'old', timestamp: 100 })],
      W,
    );
    expect(out.map((b) => b.signature)).toEqual(['old', 'new']);
  });
});

describe('watchlist persistence', () => {
  let dir: string;
  let mod: typeof import('../src/data/watchlist.js');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xray-watch-'));
    process.env.WATCHLIST_PATH = join(dir, 'watchlist.json');
    const { resetModules } = await import('vitest').then((v) => ({ resetModules: v.vi.resetModules }));
    resetModules();
    mod = await import('../src/data/watchlist.js');
    mod.__resetForTests();
  });

  afterEach(async () => {
    delete process.env.WATCHLIST_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it('adds, lists and removes', async () => {
    expect(await mod.watchWallet(1, W, 'from $TEST')).toBe('added');
    expect((await mod.listWatched(1)).map((e) => e.wallet)).toEqual([W]);
    expect(await mod.isWatched(1, W)).toBe(true);
    expect(await mod.unwatchWallet(1, W)).toBe(true);
    expect(await mod.listWatched(1)).toEqual([]);
  });

  it('refuses a duplicate for the same chat', async () => {
    await mod.watchWallet(1, W, 'a');
    expect(await mod.watchWallet(1, W, 'b')).toBe('duplicate');
  });

  it('keeps chats separate', async () => {
    await mod.watchWallet(1, W, 'a');
    expect(await mod.isWatched(2, W)).toBe(false);
    // Two users may track the same wallet independently.
    expect(await mod.watchWallet(2, W, 'b')).toBe('added');
    expect(await mod.listWatched(2)).toHaveLength(1);
  });

  it('survives a reload from disk', async () => {
    await mod.watchWallet(1, W, 'persisted');
    const raw = JSON.parse(await readFile(process.env.WATCHLIST_PATH!, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].wallet).toBe(W);
  });

  it('records the polling cursor', async () => {
    await mod.watchWallet(1, W, 'x');
    await mod.setCursor(1, W, 'sigABC');
    expect((await mod.listWatched(1))[0]!.lastSignature).toBe('sigABC');
  });
});

describe('mergeBuysByMint', () => {
  const buy = (mint: string, sol: number, ts: number, sig: string) => ({
    wallet: W, mint, tokenAmount: 100, solSpent: sol, ts, signature: sig,
  });

  it('sums repeat buys of the same token into one', async () => {
    const { mergeBuysByMint } = await import('../src/engine/walletWatch.js');
    const out = mergeBuysByMint([
      buy(MINT, 5.057, 100, 'a'),
      buy(MINT, 5.055, 200, 'b'),
    ]);
    expect(out).toHaveLength(1);
    // The combined size is what the wallet actually committed.
    expect(out[0]!.solSpent).toBeCloseTo(10.112, 6);
    expect(out[0]!.tokenAmount).toBe(200);
    // And the link points at the most recent transaction.
    expect(out[0]!.signature).toBe('b');
    expect(out[0]!.ts).toBe(200);
  });

  it('keeps different tokens separate', async () => {
    const { mergeBuysByMint } = await import('../src/engine/walletWatch.js');
    const out = mergeBuysByMint([buy(MINT, 1, 100, 'a'), buy('OtherMint111', 2, 200, 'b')]);
    expect(out).toHaveLength(2);
  });

  it('orders oldest first', async () => {
    const { mergeBuysByMint } = await import('../src/engine/walletWatch.js');
    const out = mergeBuysByMint([buy('B111', 1, 300, 'b'), buy('A111', 1, 100, 'a')]);
    expect(out.map((b) => b.signature)).toEqual(['a', 'b']);
  });

  it('handles an empty input', async () => {
    const { mergeBuysByMint } = await import('../src/engine/walletWatch.js');
    expect(mergeBuysByMint([])).toEqual([]);
  });
});

describe('only watchable wallets reach the list', () => {
  it('accepts both address shapes now that EVM wallets are polled too', async () => {
    // EVM wallets are read from Transfer logs rather than Helius, which indexes
    // both parties of every transfer — so the chain can be asked what moved for
    // one address without naming a single token.
    const { isWatchableWallet } = await import('../src/data/watchlist.js');
    expect(isWatchableWallet('7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8')).toBe(true);
    expect(isWatchableWallet('0x8367d463abda0b0270e81e6e5f5d701f8d3cf82d')).toBe(true);
  });

  it('rejects shapes that are neither', async () => {
    const { isWatchableWallet } = await import('../src/data/watchlist.js');
    expect(isWatchableWallet('')).toBe(false);
    expect(isWatchableWallet('too-short')).toBe(false);
    // 0 and O are not in the base58 alphabet.
    expect(isWatchableWallet('0OOO0OOO0OOO0OOO0OOO0OOO0OOO0OOO')).toBe(false);
  });
});

describe('activity kinds', () => {
  const WALLET = W;
  /** One transaction moving `sol` SOL and `token` tokens for the wallet. */
  const txWith = ({ sol, token }: { sol: number; token: number }): HeliusTx =>
    tx({
      accountData: [
        {
          account: W,
          nativeBalanceChange: Math.round(sol * 1e9),
          tokenBalanceChanges: [
            {
              userAccount: W,
              tokenAccount: 'ta',
              mint: MINT,
              rawTokenAmount: { tokenAmount: String(Math.round(token * 1e6)), decimals: 6 },
            },
          ],
        },
      ],
    } as Partial<HeliusTx>);

  it('separates a buy from a transfer in by the SOL leg', () => {
    // Both raise the token balance. Only one of them cost anything.
    const bought = detectActivity(
      txWith({ sol: -0.5, token: +1000 }),
      WALLET,
    );
    const airdropped = detectActivity(txWith({ sol: 0, token: +1000 }), WALLET);
    expect(bought[0]!.kind).toBe('buy');
    expect(airdropped[0]!.kind).toBe('transfer-in');
  });

  it('separates a sell from a transfer out by the SOL leg', () => {
    // A wallet moving its position to an alt is not a sale — that distinction
    // is the whole supply-relay pattern.
    const sold = detectActivity(txWith({ sol: +0.5, token: -1000 }), WALLET);
    const sent = detectActivity(txWith({ sol: 0, token: -1000 }), WALLET);
    expect(sold[0]!.kind).toBe('sell');
    expect(sent[0]!.kind).toBe('transfer-out');
  });

  it('reports amounts as magnitudes, with direction in the kind', () => {
    const sold = detectActivity(txWith({ sol: +0.5, token: -1000 }), WALLET);
    expect(sold[0]!.tokenAmount).toBeGreaterThan(0);
    expect(sold[0]!.solSpent).toBeGreaterThan(0);
  });

  it('filters map to the kinds they name', () => {
    expect(matchesFilter('buy', 'buys')).toBe(true);
    expect(matchesFilter('sell', 'buys')).toBe(false);
    expect(matchesFilter('transfer-out', 'transfers')).toBe(true);
    expect(matchesFilter('transfer-in', 'transfers')).toBe(true);
    for (const k of ['buy', 'sell', 'transfer-in', 'transfer-out'] as const) {
      expect(matchesFilter(k, 'all')).toBe(true);
    }
  });

  it('never merges a buy and a sell of the same token', () => {
    // Two decisions, not one — netting them would report a sale as a purchase.
    const merged = mergeBuysByMint([
      { wallet: WALLET, mint: 'M', tokenAmount: 100, solSpent: 1, ts: 1, signature: 'a', kind: 'buy' },
      { wallet: WALLET, mint: 'M', tokenAmount: 100, solSpent: 1, ts: 2, signature: 'b', kind: 'sell' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.kind).sort()).toEqual(['buy', 'sell']);
  });
});
