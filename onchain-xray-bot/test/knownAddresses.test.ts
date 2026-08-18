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
