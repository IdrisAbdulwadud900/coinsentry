import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The poller runs unattended, so a bug here is invisible: no error, no alert,
 * just silence that looks exactly like a quiet wallet.
 */
const W = 'Watched11111111111111111111111111111111111';
const MINT = 'NewCoin111111111111111111111111111111111111';

let txs: unknown[] = [];
// The poller dedupes on chatId + signature + mint, in a Set that lives for the
// life of the process. Tests must therefore each use their own signature, or
// the first one consumes the alert and the rest see silence that looks exactly
// like a broken filter.
let sig = 0;
const nextSig = () => `sig${++sig}`;
vi.mock('../src/data/helius.js', async () => {
  const actual = await vi.importActual<typeof import('../src/data/helius.js')>(
    '../src/data/helius.js',
  );
  return {
    ...actual,
    HeliusClient: {
      ...actual.HeliusClient,
      fromConfig: () => ({
        listSignatures: async () => [{ signature: currentSig, slot: 1, blockTime: 1, err: null }],
        hydrate: async () => ({ txs, failed: 0 }),
      }),
    },
  };
});
vi.mock('../src/data/jupiter.js', () => ({
  getToken: async () => ({ symbol: 'NEW', name: 'New Coin', mcap: 50_000, audit: {} }),
}));

let currentSig = 'sig0';

const { pollWatchlist } = await import('../src/engine/watchPoller.js');
const watchlist = await import('../src/data/watchlist.js');

/** One transaction where the wallet moves SOL and tokens. */
const tx = (sol: number, token: number) => ({
  signature: currentSig, timestamp: 1_700_000_000, slot: 1, type: 'SWAP',
  source: 'PUMP_FUN', fee: 5_000, feePayer: W,
  accountData: [
    { account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [
      { userAccount: W, tokenAccount: 'ta', mint: MINT,
        rawTokenAmount: { tokenAmount: String(Math.round(token * 1e6)), decimals: 6 } },
    ] },
  ],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xray-poll-'));
  process.env.WATCHLIST_PATH = join(dir, 'w.json');
  process.env.BUYLOG_PATH = join(dir, 'b.json');
  watchlist.__resetForTests();
  txs = [];
});
afterEach(async () => {
  delete process.env.WATCHLIST_PATH;
  delete process.env.BUYLOG_PATH;
  await rm(dir, { recursive: true, force: true });
});

/** Adds a wallet already past its baseline, so the next poll can alert. */
async function watching(filter: 'buys' | 'sells' | 'transfers' | 'all') {
  currentSig = nextSig();
  await watchlist.watchWallet(1, W, 'test', filter);
  await watchlist.setCursor(1, W, 'baseline');
}

describe('the poller honours each filter', () => {
  it('reports a sell to a sells watcher', async () => {
    await watching('sells');
    txs = [tx(+2, -1000)];
    const alerts = await pollWatchlist();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('sell');
  });

  it('stays silent about a sell for a buys watcher', async () => {
    await watching('buys');
    txs = [tx(+2, -1000)];
    expect(await pollWatchlist()).toHaveLength(0);
  });

  it('reports a transfer out, which moves no SOL at all', async () => {
    // The size floor is measured in SOL. Applied here it would discard every
    // transfer the user asked to see.
    await watching('transfers');
    txs = [tx(0, -1000)];
    const alerts = await pollWatchlist();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('transfer-out');
  });

  it('reports everything to an all watcher', async () => {
    await watching('all');
    txs = [tx(-2, +1000)];
    const alerts = await pollWatchlist();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('buy');
  });

  it('never converges on a sell', async () => {
    // Convergence means two wallets BOUGHT the same coin. Two wallets dumping
    // it must not raise a signal that reads as accumulation.
    await watching('all');
    txs = [tx(+2, -1000)];
    const alerts = await pollWatchlist();
    expect(alerts[0]!.convergence).toBeNull();
  });
});
