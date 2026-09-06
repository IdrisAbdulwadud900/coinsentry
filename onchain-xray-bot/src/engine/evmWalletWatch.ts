import { CHAINS, normalizeAddress } from '../data/chains.js';
import type { Chain } from '../types/domain.js';
import type { ActivityKind } from './walletWatch.js';

/**
 * What an EVM wallet did, from Transfer logs alone.
 *
 * Solana tells you this from the transaction's own balance changes. EVM has no
 * such summary, but it does index both parties of every Transfer, so the chain
 * can be asked "what moved for this address" directly — no address filter, just
 * the wallet as a topic. Two requests per wallet per poll, over the handful of
 * blocks since the last one.
 *
 * The quote leg decides the kind, exactly as the SOL leg does on Solana. A
 * token arriving while WETH or a stablecoin leaves is a buy; a token leaving
 * while one arrives is a sell; a token moving with no quote leg at all is a
 * transfer, which is how a position gets handed to another address.
 *
 * One honest limit: a trade settled in native ETH without touching WETH emits
 * no quote Transfer, so it reads as a transfer rather than a buy. Routers wrap
 * almost universally, so this is rare — but it is a real edge, and calling such
 * a move a transfer understates rather than invents.
 */

export interface EvmActivity {
  wallet: string;
  chain: Chain;
  /** The traded token, never the quote asset. */
  token: string;
  tokenAmountRaw: bigint;
  /** Quote asset moved the other way, when there was one. */
  quoteRaw: bigint;
  quoteToken: string | null;
  kind: ActivityKind;
  blockNumber: bigint;
  tx: string;
}

export interface TransferLog {
  address: string;
  args: { from?: string; to?: string; value?: bigint };
  blockNumber?: bigint;
  transactionHash?: string;
}

/** Wrapped native and stables — the assets a trade is priced in, not the subject of it. */
function quoteAssets(chain: Chain): Set<string> {
  const spec = CHAINS[chain];
  return new Set([spec.wrappedNative, ...spec.stables].map((a) => normalizeAddress(a)));
}

/**
 * Groups a wallet's transfers into one activity per transaction.
 *
 * Per transaction rather than per log: a single swap emits at least two
 * transfers, and reporting each would turn one decision into a stream.
 */
export function classifyEvmActivity(
  logs: TransferLog[],
  wallet: string,
  chain: Chain,
): EvmActivity[] {
  const me = normalizeAddress(wallet);
  const quotes = quoteAssets(chain);

  interface Leg {
    tokenIn: Map<string, bigint>;
    tokenOut: Map<string, bigint>;
    block: bigint;
  }
  const byTx = new Map<string, Leg>();

  for (const l of logs) {
    if (!l.transactionHash || l.args.value === undefined) continue;
    const from = l.args.from ? normalizeAddress(l.args.from) : '';
    const to = l.args.to ? normalizeAddress(l.args.to) : '';
    if (from !== me && to !== me) continue;
    // A self-transfer nets to nothing and is not a decision.
    if (from === me && to === me) continue;

    const leg = byTx.get(l.transactionHash) ?? {
      tokenIn: new Map<string, bigint>(),
      tokenOut: new Map<string, bigint>(),
      block: l.blockNumber ?? 0n,
    };
    const token = normalizeAddress(l.address);
    const side = to === me ? leg.tokenIn : leg.tokenOut;
    side.set(token, (side.get(token) ?? 0n) + l.args.value);
    byTx.set(l.transactionHash, leg);
  }

  const out: EvmActivity[] = [];
  for (const [tx, leg] of byTx) {
    const inNonQuote = [...leg.tokenIn].filter(([t]) => !quotes.has(t));
    const outNonQuote = [...leg.tokenOut].filter(([t]) => !quotes.has(t));
    const inQuote = [...leg.tokenIn].filter(([t]) => quotes.has(t));
    const outQuote = [...leg.tokenOut].filter(([t]) => quotes.has(t));

    // Only one subject per transaction: the largest non-quote movement. A
    // router hop can touch several tokens, and reporting each as its own
    // decision is how one swap becomes four alerts.
    const pickLargest = (xs: [string, bigint][]) =>
      xs.reduce<[string, bigint] | null>((best, x) => (!best || x[1] > best[1] ? x : best), null);

    const gained = pickLargest(inNonQuote);
    const lost = pickLargest(outNonQuote);

    if (gained && outQuote.length > 0) {
      const paid = pickLargest(outQuote)!;
      out.push(activity(wallet, chain, gained, paid, 'buy', leg.block, tx));
    } else if (lost && inQuote.length > 0) {
      const got = pickLargest(inQuote)!;
      out.push(activity(wallet, chain, lost, got, 'sell', leg.block, tx));
    } else if (gained) {
      out.push(activity(wallet, chain, gained, null, 'transfer-in', leg.block, tx));
    } else if (lost) {
      out.push(activity(wallet, chain, lost, null, 'transfer-out', leg.block, tx));
    }
  }

  return out.sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

function activity(
  wallet: string,
  chain: Chain,
  token: [string, bigint],
  quote: [string, bigint] | null,
  kind: ActivityKind,
  blockNumber: bigint,
  tx: string,
): EvmActivity {
  return {
    wallet,
    chain,
    token: token[0],
    tokenAmountRaw: token[1],
    quoteRaw: quote ? quote[1] : 0n,
    quoteToken: quote ? quote[0] : null,
    kind,
    blockNumber,
    tx,
  };
}
