import { describe, it, expect, vi, afterEach } from 'vitest';

/** Stubs global fetch with a per-URL responder. */
function stubFetch(routes: Record<string, unknown>, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key === undefined) return { ok: false, status: 404, text: async () => 'no route', headers: new Map() };
    return {
      ok: status < 400, status,
      json: async () => routes[key],
      text: async () => JSON.stringify(routes[key]),
      headers: { get: () => null },
    };
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('dexscreener', () => {
  it('keeps only pairs where the queried token is the BASE side', async () => {
    // priceUsd describes the base asset; a pair where our token is the quote
    // would attribute the other asset's price to it.
    const { lookupToken } = await import('../src/data/dexscreener.js');
    stubFetch({
      'dexscreener.com': {
        pairs: [
          { chainId: 'solana', dexId: 'raydium', pairAddress: 'P1',
            baseToken: { address: 'OTHER', name: 'Other', symbol: 'OTH' },
            quoteToken: { address: 'MINT', name: 'Ours', symbol: 'US' },
            priceUsd: '735', liquidity: { usd: 999999 } },
          { chainId: 'solana', dexId: 'raydium', pairAddress: 'P2',
            baseToken: { address: 'MINT', name: 'Ours', symbol: 'US' },
            quoteToken: { address: 'SOL', name: 'SOL', symbol: 'SOL' },
            priceUsd: '0.0005', liquidity: { usd: 1000 } },
        ],
      },
    });
    const res = await lookupToken('MINT');
    expect(res!.all).toHaveLength(1);
    expect(res!.best.pairAddress).toBe('P2');
    expect(res!.best.priceUsd).toBeCloseTo(0.0005, 8);
  });

  it('picks the deepest liquidity, matching EVM addresses case-insensitively', async () => {
    const { lookupToken } = await import('../src/data/dexscreener.js');
    // DexScreener returns checksummed addresses; users paste lowercase. EVM hex
    // is case-insensitive, so the match must survive the difference.
    const CHECKSUMMED = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
    const mk = (addr: string, liq: number) => ({
      chainId: 'base', dexId: 'uniswap', pairAddress: addr,
      baseToken: { address: CHECKSUMMED, name: 'T', symbol: 'T' },
      quoteToken: { address: '0x4200000000000000000000000000000000000006', name: 'W', symbol: 'W' },
      priceUsd: '1', liquidity: { usd: liq },
    });
    stubFetch({ 'dexscreener.com': { pairs: [mk('LOW', 10), mk('HIGH', 900)] } });
    const res = await lookupToken(CHECKSUMMED.toLowerCase());
    expect(res).not.toBeNull();
    expect(res!.best.pairAddress).toBe('HIGH');
  });

  it('returns null rather than throwing when nothing is listed', async () => {
    const { lookupToken } = await import('../src/data/dexscreener.js');
    stubFetch({ 'dexscreener.com': { pairs: null } });
    expect(await lookupToken('MINT')).toBeNull();
  });

  it('ignores chains the bot does not cover', async () => {
    const { lookupToken } = await import('../src/data/dexscreener.js');
    stubFetch({
      'dexscreener.com': {
        pairs: [{ chainId: 'sui', dexId: 'x', pairAddress: 'P',
          baseToken: { address: 'MINT', name: 'T', symbol: 'T' },
          quoteToken: { address: 'Q', name: 'Q', symbol: 'Q' },
          priceUsd: '1', liquidity: { usd: 1 } }],
      },
    });
    expect(await lookupToken('MINT')).toBeNull();
  });
});

describe('jupiter', () => {
  const MINT = 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump';

  it('matches the mint exactly — the search endpoint is fuzzy', async () => {
    const { getToken } = await import('../src/data/jupiter.js');
    stubFetch({ 'jup.ag': [
      { id: 'SomeOtherMintEntirely1111111111111111111', symbol: 'WRONG', decimals: 6 },
      { id: MINT, symbol: 'RIGHT', decimals: 6, dev: 'DEV', totalSupply: 1e9 },
    ] });
    expect((await getToken(MINT))!.symbol).toBe('RIGHT');
  });

  it('returns null when the fuzzy search has no exact hit', async () => {
    const { getToken } = await import('../src/data/jupiter.js');
    stubFetch({ 'jup.ag': [{ id: 'NotOurMint111111111111111111111111111111', symbol: 'X', decimals: 6 }] });
    expect(await getToken(MINT)).toBeNull();
  });

  it('swallows a provider error instead of failing the whole scan', async () => {
    const { getToken } = await import('../src/data/jupiter.js');
    stubFetch({ 'jup.ag': { error: 'boom' } }, 500);
    expect(await getToken(MINT)).toBeNull();
  });
});

describe('ohlcv', () => {
  it('parses candles and carries the period per timeframe', async () => {
    const { fetchCandleSeries } = await import('../src/data/ohlcv.js');
    stubFetch({
      geckoterminal: { data: { attributes: { ohlcv_list: [
        [100, 1, 2, 0.5, 1.5, 10],
        [200, 1.5, 3, 1.4, 2.9, 20],
      ] } } },
    });
    const s = await fetchCandleSeries('solana', 'POOL', 1000, 'TOKEN');
    expect(s.candles.length).toBeGreaterThan(0);
    expect(s.candles[0]!.high).toBe(2);
    expect(s.candles[0]!.period).toBeGreaterThan(0);
  });

  it('requests the token side explicitly, not the pool default', async () => {
    const { fetchCandleSeries } = await import('../src/data/ohlcv.js');
    stubFetch({ geckoterminal: { data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1, 1]] } } } });
    await fetchCandleSeries('bsc', 'POOL', 1000, '0xTOKEN');
    const urls = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]!);
    // Omitting this reads the pool's BASE asset — WBNB's price, not the token's.
    expect(urls.every((u) => u.includes('token=0xTOKEN'))).toBe(true);
  });

  it('returns an empty series instead of throwing when unavailable', async () => {
    const { fetchCandleSeries } = await import('../src/data/ohlcv.js');
    stubFetch({ geckoterminal: { error: 'nope' } }, 500);
    const s = await fetchCandleSeries('solana', 'POOL', 1000, 'TOKEN');
    expect(s.candles).toEqual([]);
  });
});

describe('solanatracker', () => {
  it('derives entry price from the first_buy block and normalises ms timestamps', async () => {
    const { SolanaTrackerClient } = await import('../src/data/solanatracker.js');
    stubFetch({ solanatracker: [{
      wallet: 'W1',
      first_buy: { amount: 124858181.76, volume_usd: 303.69, time: 1771921733196 },
      first_buy_time: 1771921733196, first_sell_time: 1771921773874,
      held: 132200779.3, holding: 4599.3, sold: 131822146.9, sold_usd: 1351.09,
      realized: 912.85, unrealized: -3.78, total: 909.06, total_invested: 491.9,
      buy_transactions: 32, sell_transactions: 7, cost_basis: 0.01166749,
    }] });
    const [b] = await new SolanaTrackerClient('k').firstBuyers('MINT');
    expect(b!.entryTokens).toBeCloseTo(124858181.76, 1);
    expect(b!.entryUsd).toBeCloseTo(303.69, 2);
    // Seconds, not milliseconds.
    expect(b!.firstBuyTs).toBe(1771921733);
    expect(b!.buyCount).toBe(32);
  });

  it('returns an empty list on provider failure', async () => {
    const { SolanaTrackerClient } = await import('../src/data/solanatracker.js');
    stubFetch({ solanatracker: { error: 'unauthorized' } }, 401);
    expect(await new SolanaTrackerClient('k').firstBuyers('MINT')).toEqual([]);
  });
});
