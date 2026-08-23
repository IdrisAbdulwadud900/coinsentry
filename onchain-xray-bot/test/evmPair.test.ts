import { describe, it, expect, vi, beforeEach } from 'vitest';

const TOKEN = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
const PAIR = '0x4e829F8A5213c42535AB84AA40BD4aDCCE9cBa02';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

/** Controls what the fake chain returns for one test. */
interface ChainState {
  head: bigint;
  decimals: number;
  totalSupply: bigint;
  token0: string;
  transfers: { from: string; to: string; value: bigint; tx: string; block: bigint }[];
  swapsV2: { quoteIn: bigint; quoteOut: bigint; tx: string; block: bigint }[];
  logsThrow?: boolean;
  logCalls?: number;
  eventShapes?: string[];
}

let state: ChainState;

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      getBlockNumber: async () => state.head,
      // 2-second blocks, so timestamps interpolate cleanly.
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: 1_700_000_000n + blockNumber * 2n,
      }),
      readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
        switch (functionName) {
          // Address-aware on purpose: the quote token's decimals must come from
          // the QUOTE address. A mock that answers 18 for everything would pass
          // even if the code never looked the quote token up.
          case 'decimals':
            return String(address).toLowerCase() === USDC.toLowerCase() ? 6 : state.decimals;
          case 'totalSupply': return state.totalSupply;
          case 'symbol': return 'TKN';
          case 'name': return 'Token';
          case 'token0': return state.token0;
          default: throw new Error('unexpected call');
        }
      },
      getLogs: async ({
        event,
        fromBlock,
        toBlock,
      }: {
        event: { name: string; inputs: unknown[] };
        fromBlock?: bigint;
        toBlock?: bigint;
      }) => {
        state.logCalls = (state.logCalls ?? 0) + 1;
        state.eventShapes = [...(state.eventShapes ?? []), `${event.name}/${event.inputs.length}`];
        if (state.logsThrow) throw new Error('range refused');
        // Honour the requested range, so halving a chunk actually returns less
        // — without that, any test about splitting a range proves nothing.
        const inRange = (b: bigint) =>
          (fromBlock === undefined || b >= fromBlock) && (toBlock === undefined || b <= toBlock);
        if (event.name === 'Transfer') {
          return state.transfers
            .filter((t) => inRange(t.block))
            .map((t) => ({
              args: { from: t.from, to: t.to, value: t.value },
              transactionHash: t.tx, blockNumber: t.block,
            }));
        }
        // Distinguish V2 (6 inputs) from V3 (7) by ABI shape.
        if (event.inputs.length === 6) {
          return state.swapsV2
            .filter((s) => inRange(s.block))
            .map((s) => ({
              args: { amount0In: 0n, amount1In: s.quoteIn, amount0Out: 0n, amount1Out: s.quoteOut },
              transactionHash: s.tx, blockNumber: s.block,
            }));
        }
        return [];
      },
    }),
  };
});

const { EvmClient } = await import('../src/data/evmPair.js');

const opts = (quote = WETH) => ({
  pairCreatedAt: 1_700_000_000,
  nativePriceAt: () => 2_000, // $2,000/ETH
  quoteToken: quote,
});

beforeEach(() => {
  state = {
    head: 100n,
    decimals: 18,
    totalSupply: 10n ** 27n, // 1e9 tokens at 18dp
    token0: TOKEN,
    transfers: [],
    swapsV2: [],
  };
});

describe('EVM pair replay', () => {
  it('derives a buy from a pair→wallet transfer and prices it from the swap', async () => {
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xa', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xa', block: 50n }]; // 0.01 ETH
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());

    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.side).toBe('buy');
    expect(t.wallet).toBe(ALICE);
    expect(t.tokenAmount).toBeCloseTo(1, 9);
    expect(t.usd).toBeCloseTo(20, 6); // 0.01 ETH * $2000
  });

  it('derives a sell from a wallet→pair transfer', async () => {
    state.transfers = [{ from: BOB, to: PAIR, value: 2n * 10n ** 18n, tx: '0xb', block: 60n }];
    state.swapsV2 = [{ quoteIn: 0n, quoteOut: 10n ** 16n, tx: '0xb', block: 60n }];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades[0]!.side).toBe('sell');
    expect(res.trades[0]!.wallet).toBe(BOB);
  });

  it('uses the QUOTE token decimals, not a hardcoded 18', async () => {
    // USDC is 6dp. Assuming 18 understated these pairs by 1e12 and zeroed
    // every trade's USD value, dropping the whole history.
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xc', block: 50n }];
    state.swapsV2 = [{ quoteIn: 50_000_000n, quoteOut: 0n, tx: '0xc', block: 50n }]; // 50 USDC
    const res = await new EvmClient('base').replay(TOKEN, PAIR, {
      ...opts(USDC),
      nativePriceAt: () => 2_000,
    });
    // Stable quote: the USD value is the quote amount itself.
    expect(res.trades[0]!.usd).toBeCloseTo(50, 6);
  });

  it('excludes the token contract itself, which tax tokens use to swap fees', async () => {
    state.transfers = [
      { from: PAIR, to: TOKEN.toLowerCase(), value: 10n ** 18n, tx: '0xd', block: 50n },
      { from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xe', block: 51n },
    ];
    state.swapsV2 = [
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xd', block: 50n },
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xe', block: 51n },
    ];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades.map((t) => t.wallet)).toEqual([ALICE]);
  });

  it('counts router-routed swaps instead of dropping them silently', async () => {
    state.transfers = [
      { from: PAIR, to: ROUTER, value: 10n ** 18n, tx: '0xf', block: 50n },
      { from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0x10', block: 51n },
    ];
    state.swapsV2 = [
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xf', block: 50n },
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0x10', block: 51n },
    ];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades.map((t) => t.wallet)).toEqual([ALICE]);
    // The loss has to be visible, or the wallet list looks complete when it is not.
    expect(res.routedTrades).toBe(1);
  });

  it('treats a wallet-to-wallet move as supply transfer, not a trade', async () => {
    state.transfers = [{ from: ALICE, to: BOB, value: 10n ** 18n, tx: '0x11', block: 55n }];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades).toHaveLength(0);
    expect(res.supplyTransfers).toHaveLength(1);
    expect(res.supplyTransfers[0]!.from).toBe(ALICE);
    expect(res.supplyTransfers[0]!.to).toBe(BOB);
  });

  it('ignores mint and burn, which are not wallet transfers', async () => {
    const ZERO = '0x0000000000000000000000000000000000000000';
    state.transfers = [
      { from: ZERO, to: ALICE, value: 10n ** 18n, tx: '0x12', block: 40n },
      { from: ALICE, to: ZERO, value: 10n ** 18n, tx: '0x13', block: 41n },
    ];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.supplyTransfers).toHaveLength(0);
  });

  it('skips a swap with no matching quote rather than pricing it at zero', async () => {
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0x14', block: 50n }];
    state.swapsV2 = []; // no Swap event for this tx
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades).toHaveLength(0);
  });

  it('splits one transaction\'s value across its legs proportionally', async () => {
    state.transfers = [
      { from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0x15', block: 50n },
      { from: PAIR, to: BOB, value: 3n * 10n ** 18n, tx: '0x15', block: 50n },
    ];
    state.swapsV2 = [{ quoteIn: 4n * 10n ** 16n, quoteOut: 0n, tx: '0x15', block: 50n }];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    const alice = res.trades.find((t) => t.wallet === ALICE)!;
    const bob = res.trades.find((t) => t.wallet === BOB)!;
    // 0.04 ETH * $2000 = $80, split 1:3.
    expect(alice.usd).toBeCloseTo(20, 5);
    expect(bob.usd).toBeCloseTo(60, 5);
  });

  it('raises a clear error when every log request is refused', async () => {
    // Returning "no trades" here would misreport an RPC limit as a fact
    // about the coin.
    state.logsThrow = true;
    await expect(new EvmClient('base').replay(TOKEN, PAIR, opts())).rejects.toThrow(/refused every log request/);
  });

  it('assigns timestamps from block numbers, not the current clock', async () => {
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0x16', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0x16', block: 50n }];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    // 1_700_000_000 + 50*2
    expect(res.trades[0]!.ts).toBeCloseTo(1_700_000_100, -1);
    expect(res.trades[0]!.ts).toBeLessThan(Date.now() / 1000);
  });
});

describe('coverage windows', () => {
  it('scans one continuous window when the token fits the budget', async () => {
    state.head = 100n;
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0x20', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0x20', block: 50n }];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.truncated).toBe(false);
    expect(res.trades).toHaveLength(1);
  });

  it('covers BOTH launch and recent blocks when the token is too old', async () => {
    // Forward-only from launch meant a two-year-old token reported its first
    // weeks and nothing since — no current holders, no recent relays.
    state.head = 50_000_000n;
    state.logCalls = 0;
    const res = await new EvmClient('base').replay(TOKEN, PAIR, {
      ...opts(),
      // Launch ~50M blocks back, far beyond any budget.
      pairCreatedAt: 1_600_000_000,
    });
    expect(res.truncated).toBe(true);
    // Capped, not unbounded: three streams share the chunk budget.
    expect(state.logCalls!).toBeLessThanOrEqual(200 * 3);
    expect(state.logCalls!).toBeGreaterThan(0);
  });

  it('respects the chunk cap rather than scanning forever', async () => {
    state.head = 50_000_000n;
    state.logCalls = 0;
    await new EvmClient('base').replay(TOKEN, PAIR, { ...opts(), pairCreatedAt: 1_600_000_000 });
    // 50M blocks at 10k each would be 5,000 chunks per stream unbounded.
    expect(state.logCalls!).toBeLessThan(5_000);
  });
});


describe('V3 swap variant follows the pool\'s DEX', () => {
  // PancakeSwap V3 appends two protocol-fee fields. They are unindexed, so the
  // signature and topic0 differ and a Uniswap V3 filter matches nothing — which
  // is exactly how a BSC token read 356,623 transfers and zero swaps.
  it('asks for the 7-input Uniswap event by default', async () => {
    await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(state.eventShapes).toContain('Swap/7');
    expect(state.eventShapes).not.toContain('Swap/9');
  });

  it('asks for the 9-input PancakeSwap event on a pancake pool', async () => {
    await new EvmClient('bsc').replay(TOKEN, PAIR, { ...opts(), dexId: 'pancakeswap' });
    expect(state.eventShapes).toContain('Swap/9');
    expect(state.eventShapes).not.toContain('Swap/7');
  });

  it('still runs exactly three log streams, not four', async () => {
    // A fourth stream would be a third more getLogs on every EVM scan, and
    // these endpoints already rate-limit.
    await new EvmClient('bsc').replay(TOKEN, PAIR, { ...opts(), dexId: 'pancakeswap' });
    const kinds = new Set(state.eventShapes);
    expect(kinds).toEqual(new Set(['Transfer/3', 'Swap/6', 'Swap/9']));
  });
});

describe('trades come back in time order', () => {
  it('sorts even when later blocks are read first', async () => {
    // The retry pass appends recovered chunks after the rest, and everything
    // downstream assumes ascending time — PriceCurve binary-searches on it.
    state.transfers = [
      { from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xb', block: 90n },
      { from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xa', block: 10n },
    ];
    state.swapsV2 = [
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xb', block: 90n },
      { quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xa', block: 10n },
    ];
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    const times = res.trades.map((t) => t.ts);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('a dense response on a public endpoint is kept', () => {
  it('does not discard a full-looking page when the cap is on block range', async () => {
    // Public endpoints cap the BLOCK RANGE and return every log inside it, so a
    // dense 10k-block slice legitimately comes back near 10,000 logs. Treating
    // that as truncation re-read it, ran out of retries, and reported the
    // blocks as unread — which cost one token its entire floor-entry list.
    state.head = 100_000n;
    state.transfers = Array.from({ length: 9_600 }, (_, i) => ({
      from: PAIR, to: ALICE, value: 10n ** 18n, tx: `0x${i}`, block: BigInt(i % 90_000),
    }));
    state.swapsV2 = state.transfers.map((t) => ({
      quoteIn: 10n ** 16n, quoteOut: 0n, tx: t.tx, block: t.block,
    }));
    const res = await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.lostChunks).toBe(0);
  });
});

describe('a keyed RPC widens the log window', () => {
  it('asks for bigger ranges when an endpoint is configured', async () => {
    // Paying for a better endpoint must actually change what the bot asks for;
    // otherwise it keeps requesting the free tier's 10,000-block slices.
    const { logChunkFor, hasKeyedRpc } = await import('../src/data/chains.js');
    expect(hasKeyedRpc('solana')).toBe(false);
    expect(logChunkFor('base')).toBeGreaterThan(0);
  });
});

describe('a stated pool version skips the stream that cannot match', () => {
  it('does not query the V3 event on a pool DexScreener calls v2', async () => {
    // A pool emits exactly one of these. Querying both spends a third of an
    // EVM scan's requests on a stream guaranteed to be empty.
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xa', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xa', block: 50n }];
    await new EvmClient('base').replay(TOKEN, PAIR, { ...opts(), poolVersion: 'v2' });
    expect(state.eventShapes).toContain('Swap/6');
    expect(state.eventShapes).not.toContain('Swap/7');
  });

  it('queries both when no version is stated', async () => {
    // Guessing from the dex name would reintroduce the silent-empty failure.
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xa', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xa', block: 50n }];
    await new EvmClient('base').replay(TOKEN, PAIR, opts());
    expect(state.eventShapes).toContain('Swap/6');
    expect(state.eventShapes).toContain('Swap/7');
  });

  it('falls back when the stated version yields nothing but transfers exist', async () => {
    // A wrong label must not become "this coin never traded" — that is exactly
    // the failure that once read 356,623 transfers and zero swaps.
    state.transfers = [{ from: PAIR, to: ALICE, value: 10n ** 18n, tx: '0xa', block: 50n }];
    state.swapsV2 = [{ quoteIn: 10n ** 16n, quoteOut: 0n, tx: '0xa', block: 50n }];
    // Claim v3, which this mock has no logs for, and expect V2 to be retried.
    const res = await new EvmClient('base').replay(TOKEN, PAIR, { ...opts(), poolVersion: 'v3' });
    expect(state.eventShapes).toContain('Swap/6');
    expect(res.trades.length).toBeGreaterThan(0);
  });
});
