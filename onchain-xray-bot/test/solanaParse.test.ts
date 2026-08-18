import { describe, it, expect } from 'vitest';
import { parseSolanaHistory } from '../src/data/solanaParse.js';
import type { HeliusTx } from '../src/data/helius.js';

const MINT = 'MintAddress1111111111111111111111111111111';
const BUYER = 'Buyer111111111111111111111111111111111111111';
const SELLER = 'Seller11111111111111111111111111111111111111';
const POOL = 'Pool1111111111111111111111111111111111111111';
const SINK = 'Sink1111111111111111111111111111111111111111';
const FUNDER = 'Funder11111111111111111111111111111111111111';

const SUPPLY = 1_000_000_000;
const DECIMALS = 6;
const CTX = {
  mint: MINT,
  decimals: DECIMALS,
  totalSupply: SUPPLY,
  // 1 SOL = $100 throughout, so expected USD values are easy to reason about.
  solPriceAt: () => 100,
};

/** A pump.fun-style buy: 1 SOL in, 1,000 tokens out. */
function buyTx(over: Partial<HeliusTx> = {}): HeliusTx {
  return {
    signature: 'sig-buy',
    timestamp: 1_700_000_000,
    slot: 1000,
    type: 'SWAP',
    source: 'PUMP_FUN',
    fee: 5000,
    feePayer: BUYER,
    tokenTransfers: [
      {
        fromUserAccount: POOL,
        toUserAccount: BUYER,
        fromTokenAccount: 'pta',
        toTokenAccount: 'bta',
        tokenAmount: 1000,
        mint: MINT,
      },
    ],
    nativeTransfers: [],
    accountData: [
      { account: BUYER, nativeBalanceChange: -1_005_000, tokenBalanceChanges: [] },
    ],
    events: {
      swap: {
        nativeInput: { account: BUYER, amount: '1000000000' },
        tokenOutputs: [
          {
            userAccount: BUYER,
            mint: MINT,
            rawTokenAmount: { tokenAmount: '1000000000', decimals: DECIMALS },
          },
        ],
      },
    },
    ...over,
  };
}

/** A sell: 500 tokens in, 2 SOL out. */
function sellTx(over: Partial<HeliusTx> = {}): HeliusTx {
  return {
    signature: 'sig-sell',
    timestamp: 1_700_001_000,
    slot: 1100,
    type: 'SWAP',
    source: 'RAYDIUM',
    fee: 5000,
    feePayer: SELLER,
    tokenTransfers: [
      {
        fromUserAccount: SELLER,
        toUserAccount: POOL,
        fromTokenAccount: 'sta',
        toTokenAccount: 'pta',
        tokenAmount: 500,
        mint: MINT,
      },
    ],
    nativeTransfers: [],
    accountData: [{ account: SELLER, nativeBalanceChange: 1_995_000, tokenBalanceChanges: [] }],
    events: {
      swap: {
        nativeOutput: { account: SELLER, amount: '2000000000' },
        tokenInputs: [
          {
            userAccount: SELLER,
            mint: MINT,
            rawTokenAmount: { tokenAmount: '500000000', decimals: DECIMALS },
          },
        ],
      },
    },
    ...over,
  };
}

describe('parseSolanaHistory', () => {
  it('reads a swap event as a priced buy', () => {
    const { trades } = parseSolanaHistory([buyTx()], CTX);
    expect(trades).toHaveLength(1);

    const t = trades[0]!;
    expect(t.side).toBe('buy');
    expect(t.wallet).toBe(BUYER);
    expect(t.tokenAmount).toBeCloseTo(1000, 6);
    // 1 SOL at $100.
    expect(t.usd).toBeCloseTo(100, 6);
    expect(t.priceUsd).toBeCloseTo(0.1, 8);
    expect(t.mcap).toBeCloseTo(0.1 * SUPPLY, 2);
  });

  it('reads the opposite direction as a sell', () => {
    const { trades } = parseSolanaHistory([sellTx()], CTX);
    expect(trades).toHaveLength(1);

    const t = trades[0]!;
    expect(t.side).toBe('sell');
    expect(t.wallet).toBe(SELLER);
    expect(t.tokenAmount).toBeCloseTo(500, 6);
    expect(t.usd).toBeCloseTo(200, 6);
  });

  it('prefers swap-event legs over balance deltas', () => {
    // The balance delta includes rent for creating the token account, which
    // would overstate what the buyer actually paid for the tokens.
    const tx = buyTx();
    tx.accountData = [{ account: BUYER, nativeBalanceChange: -1_007_039_280, tokenBalanceChanges: [] }];
    const { trades } = parseSolanaHistory([tx], CTX);
    // Still exactly 1 SOL, not 1.007.
    expect(trades[0]!.usd).toBeCloseTo(100, 6);
  });

  it('falls back to balance deltas when no swap event was decoded', () => {
    const tx = buyTx({ events: undefined });
    tx.accountData = [
      {
        account: BUYER,
        nativeBalanceChange: -1_000_005_000,
        tokenBalanceChanges: [
          {
            userAccount: BUYER,
            tokenAccount: 'bta',
            mint: MINT,
            rawTokenAmount: { tokenAmount: '1000000000', decimals: DECIMALS },
          },
        ],
      },
    ];
    const { trades } = parseSolanaHistory([tx], CTX);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.side).toBe('buy');
    // The fee is added back, leaving the 1 SOL of swap value.
    expect(trades[0]!.usd).toBeCloseTo(100, 4);
  });

  it('separates a wallet-to-wallet transfer from a swap', () => {
    const transferTx: HeliusTx = {
      signature: 'sig-transfer',
      timestamp: 1_700_002_000,
      slot: 1200,
      type: 'TRANSFER',
      source: 'SYSTEM_PROGRAM',
      fee: 5000,
      feePayer: BUYER,
      tokenTransfers: [
        {
          fromUserAccount: BUYER,
          toUserAccount: SINK,
          fromTokenAccount: 'bta',
          toTokenAccount: 'kta',
          tokenAmount: 750,
          mint: MINT,
        },
      ],
      nativeTransfers: [],
      accountData: [],
    };

    const { trades, supplyTransfers } = parseSolanaHistory([buyTx(), transferTx], CTX);
    expect(trades).toHaveLength(1);
    expect(supplyTransfers).toHaveLength(1);

    const tr = supplyTransfers[0]!;
    expect(tr.from).toBe(BUYER);
    expect(tr.to).toBe(SINK);
    expect(tr.tokenAmount).toBeCloseTo(750, 6);
  });

  it('does not treat pool routing legs as supply transfers', () => {
    // The pool is learned from the swap in pass 1, so a later transfer touching
    // it must not be reported as a wallet handing supply to another wallet.
    const poolLeg: HeliusTx = {
      signature: 'sig-poolleg',
      timestamp: 1_700_003_000,
      slot: 1300,
      type: 'TRANSFER',
      source: 'RAYDIUM',
      fee: 5000,
      feePayer: SELLER,
      tokenTransfers: [
        {
          fromUserAccount: POOL,
          toUserAccount: SELLER,
          fromTokenAccount: 'pta',
          toTokenAccount: 'sta',
          tokenAmount: 100,
          mint: MINT,
        },
      ],
      nativeTransfers: [],
      accountData: [],
    };

    const { supplyTransfers, poolAccounts } = parseSolanaHistory([buyTx(), poolLeg], CTX);
    expect(poolAccounts.has(POOL)).toBe(true);
    expect(supplyTransfers).toHaveLength(0);
  });

  it('ignores transfers of a different mint', () => {
    const otherMint: HeliusTx = {
      signature: 'sig-other',
      timestamp: 1_700_004_000,
      slot: 1400,
      type: 'TRANSFER',
      source: 'SYSTEM_PROGRAM',
      fee: 5000,
      feePayer: BUYER,
      tokenTransfers: [
        {
          fromUserAccount: BUYER,
          toUserAccount: SINK,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 999,
          mint: 'SomeOtherMint11111111111111111111111111111',
        },
      ],
      nativeTransfers: [],
      accountData: [],
    };
    const { supplyTransfers } = parseSolanaHistory([otherMint], CTX);
    expect(supplyTransfers).toHaveLength(0);
  });

  it('extracts native funding edges and skips dust', () => {
    const funding: HeliusTx = {
      signature: 'sig-fund',
      timestamp: 1_700_005_000,
      slot: 1500,
      type: 'TRANSFER',
      source: 'SYSTEM_PROGRAM',
      fee: 5000,
      feePayer: FUNDER,
      tokenTransfers: [],
      nativeTransfers: [
        { fromUserAccount: FUNDER, toUserAccount: BUYER, amount: 2_000_000_000 },
        // Below the dust floor — rent-exemption noise, not a funding link.
        { fromUserAccount: FUNDER, toUserAccount: SINK, amount: 500_000 },
      ],
      accountData: [],
    };
    const { fundingTransfers } = parseSolanaHistory([funding], CTX);
    expect(fundingTransfers).toHaveLength(1);
    expect(fundingTransfers[0]!.from).toBe(FUNDER);
    expect(fundingTransfers[0]!.to).toBe(BUYER);
    expect(fundingTransfers[0]!.amount).toBeCloseTo(2, 6);
  });

  it('handles a signed sell amount identically to an unsigned one', () => {
    const tx = sellTx();
    tx.events!.swap!.tokenInputs![0]!.rawTokenAmount.tokenAmount = '-500000000';
    const { trades } = parseSolanaHistory([tx], CTX);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.side).toBe('sell');
    expect(trades[0]!.tokenAmount).toBeCloseTo(500, 6);
  });

  it('drops failed transactions', () => {
    const failed = buyTx({ transactionError: { InstructionError: [0, 'Custom'] } });
    const { trades } = parseSolanaHistory([failed], CTX);
    expect(trades).toHaveLength(0);
  });

  it('returns trades in chronological order', () => {
    const { trades } = parseSolanaHistory([sellTx(), buyTx()], CTX);
    expect(trades.map((t) => t.side)).toEqual(['buy', 'sell']);
  });
});

describe('ATA rent artifacts (live-data bug)', () => {
  /**
   * Reproduces the exact shape seen on $GARY: no decodable swap event, so the
   * fee payer's balance delta is the only price signal — and that delta is
   * dominated by the ~0.00204 SOL rent for opening a token account. Priced
   * naively it implies a market cap hundreds of times the real one.
   */
  function rentTx(over: Partial<HeliusTx> = {}): HeliusTx {
    return {
      signature: 'sig-rent',
      timestamp: 1_700_000_500,
      slot: 1050,
      type: 'SWAP',
      source: 'PUMP_AMM',
      fee: 5000,
      feePayer: BUYER,
      tokenTransfers: [
        {
          fromUserAccount: POOL,
          toUserAccount: BUYER,
          fromTokenAccount: 'pta',
          toTokenAccount: 'bta',
          tokenAmount: 28.88,
          mint: MINT,
        },
      ],
      nativeTransfers: [],
      accountData: [
        {
          account: BUYER,
          // -0.00204 SOL of rent, plus the fee that gets added back.
          nativeBalanceChange: -2_044_280,
          tokenBalanceChanges: [
            {
              userAccount: BUYER,
              tokenAccount: 'bta',
              mint: MINT,
              rawTokenAmount: { tokenAmount: '28880000', decimals: DECIMALS },
            },
          ],
        },
      ],
      // No events.swap — this is what forces the balance-delta fallback.
      ...over,
    };
  }

  it('drops a rent-dominated trade instead of pricing it', () => {
    const { trades } = parseSolanaHistory([rentTx()], CTX);
    expect(trades).toHaveLength(0);
  });

  it('does not let a rent artifact set the market cap', () => {
    const { trades } = parseSolanaHistory([buyTx(), rentTx()], CTX);
    expect(trades).toHaveLength(1);
    // The real buy: 1 SOL ($100) for 1000 tokens = $0.10 each = $100M mcap.
    expect(trades[0]!.mcap).toBeCloseTo(100_000_000, 0);
    // The artifact would have implied ~$7e10. Nothing near it survives.
    expect(Math.max(...trades.map((t) => t.mcap))).toBeLessThan(1e9);
  });

  it('still learns the pool from a dropped trade', () => {
    // The counterparty is real even when the price is not.
    const { poolAccounts } = parseSolanaHistory([rentTx()], CTX);
    expect(poolAccounts.has(POOL)).toBe(true);
  });

  it('keeps a genuinely small but real trade above the floor', () => {
    const real = buyTx({
      signature: 'sig-small',
      events: {
        swap: {
          nativeInput: { account: BUYER, amount: '20000000' }, // 0.02 SOL = $2
          tokenOutputs: [
            {
              userAccount: BUYER,
              mint: MINT,
              rawTokenAmount: { tokenAmount: '20000000', decimals: DECIMALS },
            },
          ],
        },
      },
    });
    const { trades } = parseSolanaHistory([real], CTX);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.usd).toBeCloseTo(2, 6);
  });
});
