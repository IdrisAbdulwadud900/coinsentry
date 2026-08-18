import { describe, it, expect } from 'vitest';
import { buildDevGraph } from '../src/engine/devGraph.js';
import { makeLedger } from './fixtures.js';
import type { Trade, FundingTransfer, SupplyTransfer } from '../src/types/domain.js';

const DEV = 'DevWa11et111111111111111111111111111111111';
const ROUTER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function trade(over: Partial<Trade> & Pick<Trade, 'wallet' | 'ts'>): Trade {
  return {
    side: 'buy', tokenAmount: 1000, usd: 10, priceUsd: 0.01,
    mcap: 1e7, tx: 't', block: over.ts, ...over,
  } as Trade;
}

function build(over: Partial<Parameters<typeof buildDevGraph>[0]> = {}) {
  return buildDevGraph({
    chain: 'solana',
    dev: DEV,
    fundingTransfers: [],
    supplyTransfers: [],
    trades: [],
    ledgers: new Map(),
    firstTradeTs: 1_000,
    totalSupply: 1e9,
    ...over,
  });
}

describe('dev graph', () => {
  it('links a wallet the dev funded', () => {
    const f: FundingTransfer[] = [{ ts: 1, from: DEV, to: 'Friend1', amount: 2, tx: 'f1' }];
    const out = build({ fundingTransfers: f });
    expect(out.map((l) => l.wallet)).toContain('Friend1');
    expect(out[0]!.links).toContain('funded-by-dev');
  });

  it('never links infrastructure, which touches every wallet on the token', () => {
    const f: FundingTransfer[] = [
      { ts: 1, from: DEV, to: ROUTER, amount: 2, tx: 'f1' },
      { ts: 2, from: DEV, to: 'RealWallet1', amount: 2, tx: 'f2' },
    ];
    const out = build({ fundingTransfers: f }).map((l) => l.wallet);
    expect(out).not.toContain(ROUTER);
    expect(out).toContain('RealWallet1');
  });

  it('never links the dev to itself', () => {
    const f: FundingTransfer[] = [{ ts: 1, from: DEV, to: DEV, amount: 1, tx: 'f1' }];
    expect(build({ fundingTransfers: f })).toHaveLength(0);
  });

  it('scores multiple independent links above a single one', () => {
    const shared: SupplyTransfer[] = [
      { ts: 5, from: DEV, to: 'Both1', tokenAmount: 100, usdAtTransfer: 1, tx: 's1', block: 5 },
    ];
    const funding: FundingTransfer[] = [{ ts: 1, from: DEV, to: 'Both1', amount: 2, tx: 'f1' }];
    const two = build({ fundingTransfers: funding, supplyTransfers: shared });
    const one = build({ fundingTransfers: funding });
    expect(two[0]!.strength).toBeGreaterThan(one[0]!.strength);
  });

  it('dilutes confidence with distance from the dev', () => {
    const f: FundingTransfer[] = [
      { ts: 1, from: DEV, to: 'Hop1', amount: 2, tx: 'f1' },
      { ts: 2, from: 'Hop1', to: 'Hop2', amount: 1, tx: 'f2' },
    ];
    const out = build({ fundingTransfers: f });
    const h1 = out.find((l) => l.wallet === 'Hop1')!;
    const h2 = out.find((l) => l.wallet === 'Hop2')!;
    expect(h2.hops).toBeGreaterThan(h1.hops);
    expect(h2.strength).toBeLessThan(h1.strength);
  });

  it('flags launch-bundle co-buyers', () => {
    const trades = [trade({ wallet: 'Sniper1', ts: 1_005 }), trade({ wallet: 'Later1', ts: 99_000 })];
    const out = build({ trades }).map((l) => l.wallet);
    expect(out).toContain('Sniper1');
    expect(out).not.toContain('Later1');
  });

  it('ranks wallets that actually traded above ones that never did', () => {
    const ledgers = new Map([['Trader1', makeLedger({ wallet: 'Trader1' })]]);
    const f: FundingTransfer[] = [
      { ts: 1, from: DEV, to: 'Idle1', amount: 5, tx: 'f1' },
      { ts: 2, from: DEV, to: 'Trader1', amount: 5, tx: 'f2' },
    ];
    const out = build({ fundingTransfers: f, ledgers });
    expect(out[0]!.wallet).toBe('Trader1');
  });

  it('returns nothing when the dev is unknown', () => {
    expect(build({ dev: '' })).toHaveLength(0);
  });

  it('keeps confidence within 1-100', () => {
    const f: FundingTransfer[] = [{ ts: 1, from: DEV, to: 'W1', amount: 1, tx: 'f1' }];
    const s: SupplyTransfer[] = [
      { ts: 2, from: DEV, to: 'W1', tokenAmount: 1, usdAtTransfer: 1, tx: 's1', block: 2 },
    ];
    for (const l of build({ fundingTransfers: f, supplyTransfers: s, trades: [trade({ wallet: 'W1', ts: 1_001 })] })) {
      expect(l.strength).toBeGreaterThanOrEqual(1);
      expect(l.strength).toBeLessThanOrEqual(100);
    }
  });
});
