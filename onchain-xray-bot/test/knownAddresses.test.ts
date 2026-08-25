import { describe, it, expect } from 'vitest';
import {
  isInfrastructure,
  isNonTrader,
  isExchange,
  addressLabel,
  lookupAddress,
} from '../src/data/knownAddresses.js';

describe('known address registry', () => {
  it('recognises Solana programs regardless of the caller', () => {
    expect(isInfrastructure('solana', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    expect(addressLabel('solana', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')).toBe('pump.fun');
  });

  it('matches EVM addresses case-insensitively', () => {
    const lower = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
    expect(addressLabel('ethereum', lower)).toBe('Uniswap V2 Router');
    expect(addressLabel('ethereum', lower.toUpperCase().replace('0X', '0x'))).toBe(
      'Uniswap V2 Router',
    );
  });

  it('does NOT lowercase Solana base58, which is case-sensitive', () => {
    // A lowercased Solana address is a different address and must not match.
    expect(lookupAddress('solana', 'tokenkegqfezyinwajbnbgkpfxcwubvf9ss623vq5da')).toBeNull();
  });

  it('separates exchanges from other infrastructure', () => {
    // A router is never a person; an exchange is a real destination for supply.
    expect(isNonTrader('ethereum', '0x7a250d5630b4cf539739df2c5dacb4c659f2488d')).toBe(true);
    expect(isNonTrader('solana', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')).toBe(false);
    expect(isExchange('solana', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')).toBe(true);
  });

  it('treats burn addresses as infrastructure', () => {
    expect(isNonTrader('base', '0x000000000000000000000000000000000000dEaD')).toBe(true);
  });

  it('returns nothing for an ordinary wallet', () => {
    expect(isInfrastructure('solana', 'E167VuSkzyxkpoWe2ZcHSEP7ApypZTSQcAz3BttAWhFF')).toBe(false);
    expect(addressLabel('ethereum', '0xaf2358e98683265cbd3a48509123d390ddf54534')).toBeNull();
  });
});

describe('token contract and routers are not traders', () => {
  it('excludes a tax token\'s own contract', async () => {
    // NAILONG on BNB Chain: the token contract swaps its collected fees and
    // accounted for 8,005 of 22,294 trades — a third of the history credited
    // to a "wallet" that is the token itself, setting a floor no buyer paid.
    const { isNonTrader } = await import('../src/data/knownAddresses.js');
    // The contract is excluded by identity comparison in the parser, and the
    // routers alongside it by the registry.
    expect(isNonTrader('bsc', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4')).toBe(true);
    expect(isNonTrader('bsc', '0x10ed43c718714eb63d5aa57b78b54704e256024e')).toBe(true);
  });

  it('leaves an ordinary BNB Chain wallet alone', async () => {
    const { isNonTrader } = await import('../src/data/knownAddresses.js');
    expect(isNonTrader('bsc', '0xe2ce6ab80874f21510f8f9b9dad2c1e191c1b4e2')).toBe(false);
  });
});

describe('HyperEVM is wired into every chain map', () => {
  it('has a spec with the endpoints and quote assets verified live', async () => {
    // Every Record<Chain, ...> in the codebase must cover it, or a scan reaches
    // an undefined and fails somewhere far from the cause.
    const { CHAINS } = await import('../src/data/chains.js');
    const spec = CHAINS.hyperevm;
    expect(spec.dexScreenerId).toBe('hyperevm');
    expect(spec.nativeSymbol).toBe('HYPE');
    // WHYPE. The vanity address is genuine, not a placeholder.
    expect(spec.wrappedNative).toBe('0x5555555555555555555555555555555555555555');
    expect(spec.stables.length).toBeGreaterThan(0);
    expect(spec.keylessArchive).toBe(true);
  });

  it('resolves the chain from DexScreener s slug', async () => {
    const { chainFromDexScreenerId } = await import('../src/data/chains.js');
    expect(chainFromDexScreenerId('hyperevm')).toBe('hyperevm');
  });

  it('links to an explorer that exists', async () => {
    const { walletUrl, tokenUrl } = await import('../src/util/format.js');
    expect(walletUrl('hyperevm', '0xabc')).toContain('hyperevmscan.io');
    expect(tokenUrl('hyperevm', '0xabc')).toContain('hyperevmscan.io');
  });

  it('prefers the endpoint that serves wide log ranges', async () => {
    // Hyperliquid's own RPC and hypurrscan cap at 500 blocks; drpc serves
    // 10,000. Leading with a narrow one would make every scan 20x the requests.
    const { CHAINS, logChunkFor } = await import('../src/data/chains.js');
    expect(CHAINS.hyperevm.rpcUrls[0]).toContain('drpc.org');
    expect(logChunkFor('hyperevm')).toBeGreaterThanOrEqual(10_000);
  });
});

describe('Robinhood Chain is wired into every chain map', () => {
  it('has a spec with the endpoint and quote assets verified live', async () => {
    const { CHAINS } = await import('../src/data/chains.js');
    const spec = CHAINS.robinhood;
    expect(spec.dexScreenerId).toBe('robinhood');
    expect(spec.nativeSymbol).toBe('ETH');
    expect(spec.wrappedNative).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    expect(spec.stables.length).toBeGreaterThan(0);
  });

  it('runs fewer parallel log requests than the default', async () => {
    // Ten parallel requests lose two on this endpoint, which cost 41% of a
    // scan. It reports the overload as "Missing or invalid parameters", so it
    // reads like a bad query rather than back-off.
    const { logConcurrencyFor } = await import('../src/data/chains.js');
    expect(logConcurrencyFor('robinhood')).toBeLessThan(logConcurrencyFor('base'));
  });

  it('resolves the chain and links to its explorer', async () => {
    const { chainFromDexScreenerId } = await import('../src/data/chains.js');
    const { walletUrl } = await import('../src/util/format.js');
    expect(chainFromDexScreenerId('robinhood')).toBe('robinhood');
    expect(walletUrl('robinhood', '0xabc')).toContain('robinhoodchain.blockscout.com');
  });
});
