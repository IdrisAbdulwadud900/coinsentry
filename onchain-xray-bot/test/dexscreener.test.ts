import { describe, it, expect } from 'vitest';
import { pickBestPair } from '../src/data/dexscreener.js';
import type { PairInfo } from '../src/data/dexscreener.js';

const V4_POOL_ID = '0x' + 'a'.repeat(64);
const READABLE = '0x' + 'b'.repeat(40);
const DEEP_READABLE = '0x' + 'c'.repeat(40);

function pair(pairAddress: string, liquidityUsd: number, chain: PairInfo['chain'] = 'base'): PairInfo {
  return {
    chain,
    dexId: 'uniswap',
    pairAddress,
    quoteToken: '0xweth',
    quoteSymbol: 'WETH',
    name: 'T',
    symbol: 'T',
    priceUsd: 1,
    mcap: 0,
    liquidityUsd,
    volume24hUsd: 0,
    pairCreatedAt: null,
    imageUrl: null,
    websites: [],
    socials: [],
  };
}

describe('pool choice must be replayable', () => {
  it('steps down to a readable pool when the deepest is a V4 poolId', () => {
    // V4 keeps every pool in one PoolManager and names them by a 32-byte id,
    // so that "pair address" is not a contract and getLogs finds nothing.
    const best = pickBestPair([pair(V4_POOL_ID, 410_000), pair(READABLE, 162_000)]);
    expect(best.pairAddress).toBe(READABLE);
  });

  it('keeps the deepest pool when the only readable one is dust', () => {
    // A $1.4k pair prices the token far worse than a deep V4 pool does, and a
    // wrong price is a worse failure than an unreadable replay.
    const best = pickBestPair([pair(V4_POOL_ID, 410_000), pair(READABLE, 1_400)]);
    expect(best.pairAddress).toBe(V4_POOL_ID);
  });

  it('takes the deepest when it is already readable', () => {
    const best = pickBestPair([pair(DEEP_READABLE, 900_000), pair(READABLE, 162_000)]);
    expect(best.pairAddress).toBe(DEEP_READABLE);
  });

  it('leaves Solana alone, where base58 is not an EVM address', () => {
    // Every Solana pool fails the EVM shape test, so without a guard this would
    // hunt for a "readable" pool on a chain that has no V4 singleton at all.
    const deep = pair('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 900_000, 'solana');
    const small = pair('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 100_000, 'solana');
    expect(pickBestPair([deep, small]).pairAddress).toBe(deep.pairAddress);
  });

  it('falls back to the only pool there is', () => {
    expect(pickBestPair([pair(V4_POOL_ID, 5)]).pairAddress).toBe(V4_POOL_ID);
  });
});
