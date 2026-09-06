import { describe, it, expect } from 'vitest';
import { isV4PoolId, v4PoolsOf, hasV4Support, resolveV4TokenSide } from '../src/data/evmPair.js';

const POOL_ID = '0x' + 'a'.repeat(64);
const ADDRESS = '0x' + 'b'.repeat(40);

describe('V4 pool identification', () => {
  it('tells a 32-byte poolId from a 20-byte contract address', () => {
    // V4 keeps every pool in one PoolManager and names them by id, so this is
    // the only signal that there is no contract to read logs from.
    expect(isV4PoolId(POOL_ID)).toBe(true);
    expect(isV4PoolId(ADDRESS)).toBe(false);
  });

  it('keeps each V4 pool with its own quote currency, in depth order', () => {
    // The currency has to travel with the pool: one token's deepest pool is in
    // ETH and fifteen more are in USDC, and valuing them through one divisor
    // understated the USDC side a trillion-fold.
    const ETH = '0x0000000000000000000000000000000000000000';
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const usdcPool = '0x' + 'c'.repeat(64);
    const out = v4PoolsOf([
      { pairAddress: ADDRESS, quoteToken: ETH },
      { pairAddress: POOL_ID, quoteToken: ETH },
      { pairAddress: usdcPool, quoteToken: USDC },
    ]);
    expect(out).toEqual([
      { id: POOL_ID, quoteToken: ETH },
      { id: usdcPool, quoteToken: USDC },
    ]);
  });

  it('drops non-V4 pools, which have their own contracts to read', () => {
    expect(v4PoolsOf([{ pairAddress: ADDRESS, quoteToken: '0x0' }])).toEqual([]);
  });

  it('knows which chains have a PoolManager', () => {
    expect(hasV4Support('base')).toBe(true);
    expect(hasV4Support('ethereum')).toBe(true);
    expect(hasV4Support('bsc')).toBe(true);
    expect(hasV4Support('solana')).toBe(false);
  });
});

describe('V4 currency side is measured, not assumed', () => {
  // There is no token0() to call, and address ordering cannot be assumed
  // either: a native-ETH pool sorts against address(0), not WETH.
  const swap = (tx: string, amount0: bigint, amount1: bigint) => ({
    transactionHash: tx,
    args: { amount0, amount1 },
  });

  it('picks the side whose magnitude matches the token transfer', () => {
    // 26,828 tokens moved; amount1 matches, so the token is currency1.
    const logs = [swap('0x1', -182381621901150983n, 26828907331694372763663n)];
    const moved = new Map([['0x1', 26828.907331694372]]);
    expect(resolveV4TokenSide(logs, moved, 18)).toBe(false);
  });

  it('reports currency0 when that is the matching side', () => {
    const logs = [swap('0x1', 26828907331694372763663n, -182381621901150983n)];
    const moved = new Map([['0x1', 26828.907331694372]]);
    expect(resolveV4TokenSide(logs, moved, 18)).toBe(true);
  });

  it('skips swaps with no matching transfer and keeps looking', () => {
    const logs = [
      swap('0xnope', 1n, 2n),
      swap('0x1', 5_000_000000000000000000n, -1n),
    ];
    const moved = new Map([['0x1', 5000]]);
    expect(resolveV4TokenSide(logs, moved, 18)).toBe(true);
  });

  it('gives up rather than guessing when nothing matches', () => {
    // Unpriced is recoverable; mispriced silently corrupts every trade.
    expect(resolveV4TokenSide([swap('0x1', 1n, 2n)], new Map(), 18)).toBe(false);
  });
});
