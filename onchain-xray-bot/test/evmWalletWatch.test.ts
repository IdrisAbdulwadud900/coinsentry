import { describe, it, expect } from 'vitest';
import { classifyEvmActivity, type TransferLog } from '../src/engine/evmWalletWatch.js';

const W = '0x65d3afb65c641b45b9f344cfb725439bec322382';
const TOKEN = '0x44635ea15c7ad175363bbeea3926e507b129a8fc';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OTHER = '0x1111111111111111111111111111111111111111';

const log = (address: string, from: string, to: string, value: bigint, tx = '0xa'): TransferLog => ({
  address,
  args: { from, to, value },
  blockNumber: 100n,
  transactionHash: tx,
});

describe('reading an EVM wallet from Transfer logs alone', () => {
  it('calls a token in with WETH out a buy', () => {
    // The quote leg decides, exactly as the SOL leg does on Solana.
    const acts = classifyEvmActivity(
      [log(TOKEN, OTHER, W, 1000n), log(WETH, W, OTHER, 5n)],
      W,
      'base',
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]!.kind).toBe('buy');
    expect(acts[0]!.token).toBe(TOKEN);
    expect(acts[0]!.quoteToken).toBe(WETH);
  });

  it('calls a token out with WETH in a sell', () => {
    const acts = classifyEvmActivity(
      [log(TOKEN, W, OTHER, 1000n), log(WETH, OTHER, W, 5n)],
      W,
      'base',
    );
    expect(acts[0]!.kind).toBe('sell');
  });

  it('treats a stablecoin as a quote asset too', () => {
    const acts = classifyEvmActivity(
      [log(TOKEN, OTHER, W, 1000n), log(USDC, W, OTHER, 50n)],
      W,
      'base',
    );
    expect(acts[0]!.kind).toBe('buy');
    expect(acts[0]!.quoteToken).toBe(USDC);
  });

  it('calls a token moving with no quote leg a transfer', () => {
    // This is how a position gets handed to another address, and it must not
    // be mistaken for a sale.
    const outward = classifyEvmActivity([log(TOKEN, W, OTHER, 1000n)], W, 'base');
    const inward = classifyEvmActivity([log(TOKEN, OTHER, W, 1000n)], W, 'base');
    expect(outward[0]!.kind).toBe('transfer-out');
    expect(inward[0]!.kind).toBe('transfer-in');
  });

  it('reports one activity per transaction, not one per log', () => {
    // A router hop touches several tokens; one swap must not become four
    // alerts.
    const acts = classifyEvmActivity(
      [
        log(TOKEN, OTHER, W, 1000n),
        log(WETH, W, OTHER, 5n),
        log(USDC, W, OTHER, 1n),
      ],
      W,
      'base',
    );
    expect(acts).toHaveLength(1);
  });

  it('keeps separate transactions separate', () => {
    const acts = classifyEvmActivity(
      [log(TOKEN, OTHER, W, 1000n, '0xa'), log(TOKEN, W, OTHER, 1000n, '0xb')],
      W,
      'base',
    );
    expect(acts).toHaveLength(2);
  });

  it('ignores transfers the wallet is not part of', () => {
    expect(classifyEvmActivity([log(TOKEN, OTHER, OTHER, 1n)], W, 'base')).toHaveLength(0);
  });

  it('ignores a self-transfer, which nets to nothing', () => {
    expect(classifyEvmActivity([log(TOKEN, W, W, 1n)], W, 'base')).toHaveLength(0);
  });

  it('picks the largest movement when a hop touches several tokens', () => {
    const acts = classifyEvmActivity(
      [log(TOKEN, OTHER, W, 9_000n), log(OTHER, OTHER, W, 5n), log(WETH, W, OTHER, 5n)],
      W,
      'base',
    );
    expect(acts[0]!.token).toBe(TOKEN);
  });
});
