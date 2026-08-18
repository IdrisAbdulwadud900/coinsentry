import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

function stubFetch(routes: Record<string, unknown>, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key === undefined) return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
    return {
      ok: status < 400, status,
      json: async () => routes[key],
      text: async () => JSON.stringify(routes[key]),
      headers: { get: () => null },
    };
  }));
}

/** A DexScreener reply that prices the wrapped-native asset at `spot`. */
const dexSpot = (addr: string, spot: number) => ({
  pairs: [{
    chainId: 'solana', dexId: 'raydium', pairAddress: 'P',
    baseToken: { address: addr, name: 'W', symbol: 'W' },
    quoteToken: { address: 'USDC', name: 'USDC', symbol: 'USDC' },
    priceUsd: String(spot), liquidity: { usd: 1e9 },
  }],
});

const SOL = 'So11111111111111111111111111111111111111112';

// The oracle keeps a module-level price series for 30 minutes so a burst of
// scans does not hammer CoinGecko. That is deliberate in production and shared
// state in tests, so each case gets a fresh module.
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('NativePriceOracle', () => {
  it('interpolates between the samples bracketing a timestamp', async () => {
    const { NativePriceOracle } = await import('../src/data/nativePrice.js');
    stubFetch({
      'dexscreener': dexSpot(SOL, 100),
      'coingecko': { prices: [[1_000_000, 100], [2_000_000, 200]] },
    });
    const o = await NativePriceOracle.create('solana', 1_000);
    // Exactly halfway between the two samples.
    expect(o.at(1_500)).toBeCloseTo(150, 6);
    expect(o.at(1_000)).toBeCloseTo(100, 6);
  });

  it('clamps to the first sample before history begins', async () => {
    const { NativePriceOracle } = await import('../src/data/nativePrice.js');
    stubFetch({
      'dexscreener': dexSpot(SOL, 100),
      'coingecko': { prices: [[5_000_000, 60], [6_000_000, 70]] },
    });
    const o = await NativePriceOracle.create('solana', 1_000);
    // A trade older than the series still gets the oldest known rate, not zero.
    expect(o.at(100)).toBeCloseTo(60, 6);
  });

  it('uses live spot beyond the end of the series', async () => {
    const { NativePriceOracle } = await import('../src/data/nativePrice.js');
    stubFetch({
      'dexscreener': dexSpot(SOL, 250),
      'coingecko': { prices: [[1_000_000, 100], [2_000_000, 200]] },
    });
    const o = await NativePriceOracle.create('solana', 1_000);
    expect(o.at(9_999_999)).toBeCloseTo(250, 6);
  });

  it('falls back to spot and SAYS so when history is unavailable', async () => {
    // Silently pricing a three-week-old trade at today's rate would mis-state
    // every entry market cap, so this must be visible to the caller.
    const { NativePriceOracle } = await import('../src/data/nativePrice.js');
    stubFetch({ 'dexscreener': dexSpot(SOL, 77) }); // coingecko 404s
    const o = await NativePriceOracle.create('solana', 1_000);
    expect(o.isSpotOnly).toBe(true);
    expect(o.at(12_345)).toBeCloseTo(77, 6);
  });

  it('never returns a negative or NaN rate', async () => {
    const { NativePriceOracle } = await import('../src/data/nativePrice.js');
    stubFetch({
      'dexscreener': dexSpot(SOL, 100),
      'coingecko': { prices: [[1_000_000, 100], [2_000_000, 0], [3_000_000, -5]] },
    });
    const o = await NativePriceOracle.create('solana', 1_000);
    for (const t of [0, 1_500, 2_500, 9e9]) {
      expect(Number.isFinite(o.at(t))).toBe(true);
      expect(o.at(t)).toBeGreaterThan(0);
    }
  });
});

describe('blockscout contract creator', () => {
  it('reads the deployer from the address record', async () => {
    const { getContractCreator } = await import('../src/data/blockscout.js');
    stubFetch({ 'blockscout': { creator_address_hash: '0xDeAdBeef00000000000000000000000000000001' } });
    const dev = await getContractCreator('ethereum', '0xtoken');
    expect(dev).toBe('0xdeadbeef00000000000000000000000000000001');
  });

  it('returns null for a chain with no explorer instance', async () => {
    const { getContractCreator } = await import('../src/data/blockscout.js');
    stubFetch({ 'blockscout': { creator_address_hash: '0xabc' } });
    // BNB Chain has no public Blockscout, and guessing a dev would be worse.
    expect(await getContractCreator('bsc', '0xtoken')).toBeNull();
  });

  it('returns null instead of throwing when the explorer errors', async () => {
    const { getContractCreator } = await import('../src/data/blockscout.js');
    stubFetch({ 'blockscout': { message: 'not found' } }, 404);
    expect(await getContractCreator('ethereum', '0xtoken')).toBeNull();
  });

  it('returns null when the record has no creator field', async () => {
    const { getContractCreator } = await import('../src/data/blockscout.js');
    stubFetch({ 'blockscout': { hash: '0xtoken' } });
    expect(await getContractCreator('base', '0xtoken')).toBeNull();
  });
});
