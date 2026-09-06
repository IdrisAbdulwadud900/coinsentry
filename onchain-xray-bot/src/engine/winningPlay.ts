import type { FirstBuyer } from '../data/solanatracker.js';
import type { WalletLedger } from '../types/domain.js';
import { config } from '../config.js';

/**
 * Which STYLE of trade made the money on this coin.
 *
 * Every other screen answers "who". This answers "how", and the two are not the
 * same question. Knowing that eleven wallets got rich here is only useful if
 * you also know whether they got rich by sniping the first block and dumping
 * into the pump, or by buying an hour later and sitting through it — because
 * those are different skills, and only one of them is repeatable by someone
 * reading this after the fact.
 *
 * The classification is deliberately coarse. Two axes decide it:
 *
 *  - WHEN they arrived, measured from the launch rather than in absolute time,
 *    so a coin that ran for an hour and one that ran for a month are comparable.
 *  - WHAT they did after, from the buy and sell counts and what is still held.
 *
 * Two very different sources feed this, so it takes a neutral input rather than
 * either one's row type. On Solana it reads the first-buyer record — NOT the
 * profit leaderboard, which returns profit but no timestamps and no buy/sell
 * counts, leaving nothing to classify on. On EVM chains there is no such
 * provider at all, and the input is our own replayed ledgers, which carry the
 * same facts because we derived them ourselves.
 *
 * Each source therefore brings its own coverage limit: the earliest wallets on
 * Solana, and whatever the replay window reached on EVM. Both are stated on the
 * screen rather than papered over.
 */

export type PlayKind =
  | 'snipe-flip'
  | 'snipe-hold'
  | 'early-hold'
  | 'scale-trim'
  | 'momentum-flip'
  | 'late-hold';

export interface PlayMeta {
  label: string;
  icon: string;
  /** Plain description of the behaviour, shown under the heading. */
  blurb: string;
}

export const PLAY_META: Record<PlayKind, PlayMeta> = {
  'snipe-flip': {
    label: 'SNIPED THE LAUNCH, FLIPPED IT',
    icon: '🎯',
    blurb: 'In within minutes of launch, out again fast.',
  },
  'snipe-hold': {
    label: 'SNIPED THE LAUNCH, SAT ON IT',
    icon: '💎',
    blurb: 'In within minutes of launch, then held through the run.',
  },
  'early-hold': {
    label: 'IN EARLY, HELD',
    icon: '🌱',
    blurb: 'Bought in the first hours and stayed put.',
  },
  'scale-trim': {
    label: 'SCALED IN, TRIMMED OUT',
    icon: '📊',
    blurb: 'Built the position over several buys, sold it in pieces.',
  },
  'momentum-flip': {
    label: 'BOUGHT THE MOVE, FLIPPED IT',
    icon: '⚡',
    blurb: 'Arrived after it was already going, took a quick profit.',
  },
  'late-hold': {
    label: 'BOUGHT LATE, STILL HOLDING',
    icon: '🪃',
    blurb: 'Came in well after launch and has not sold out.',
  },
};

/**
 * The facts a wallet must supply to be classified, independent of where they
 * came from. `stillHolding` is passed in rather than derived: the replay knows
 * it exactly from the running balance, while the provider only exposes token
 * counts, and each should give its own best answer.
 */
export interface PlayInput {
  wallet: string;
  firstBuyTs: number | null;
  firstSellTs: number | null;
  lastActivityTs: number | null;
  investedUsd: number;
  profitUsd: number;
  buyCount: number;
  sellCount: number;
  stillHolding: boolean;
}

/** Solana: the provider's first-buyer record. */
export function fromFirstBuyer(b: FirstBuyer): PlayInput {
  return {
    wallet: b.wallet,
    firstBuyTs: b.firstBuyTs,
    firstSellTs: b.firstSellTs,
    lastActivityTs: b.lastActivityTs,
    investedUsd: b.totalInvestedUsd,
    profitUsd: b.totalPnlUsd,
    buyCount: b.buyCount,
    sellCount: b.sellCount,
    stillHolding: b.holdingTokens > 0 && b.holdingTokens / Math.max(b.heldTokens, 1) > 0.02,
  };
}

/** EVM: our own replayed ledger, which has no provider equivalent. */
export function fromLedger(l: WalletLedger): PlayInput {
  return {
    wallet: l.wallet,
    firstBuyTs: l.firstBuyTs || null,
    firstSellTs: l.firstSellTs,
    lastActivityTs: l.lastActivityTs || null,
    investedUsd: l.totalBoughtUsd,
    profitUsd: l.totalPnlUsd,
    buyCount: l.buyCount,
    sellCount: l.sellCount,
    stillHolding: l.stillHolding,
  };
}

/** One style, with what it actually earned on this coin. */
export interface PlayGroup {
  kind: PlayKind;
  wallets: number;
  /** Combined profit of every wallet trading this way. */
  profitUsd: number;
  /** Typical result, so one outlier does not define the group. */
  medianMultiple: number;
  /** Typical time the position was carried, in seconds. */
  medianHoldSeconds: number | null;
  /** The single best wallet in this group. */
  bestWallet: string;
  bestProfitUsd: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/** Seconds from launch to this wallet's first buy, when both are known. */
export function entryDelay(b: PlayInput, launchTs: number | null): number | null {
  if (!launchTs || !b.firstBuyTs) return null;
  const delay = b.firstBuyTs - launchTs;
  // A negative delay means the launch timestamp is the pool's, not the token's,
  // which happens on migrated coins. Treat it as a snipe rather than guessing.
  return delay < 0 ? 0 : delay;
}

/**
 * How long the position was actually carried.
 *
 * For a wallet that exited, this is the time to the first sell. For one that is
 * still holding it is the time to its last activity instead — trimming a sliver
 * after seven seconds and keeping the rest is not a seven-second hold, and
 * measuring it that way made the screen say "sat on it, held 7s".
 */
export function holdSeconds(b: PlayInput): number | null {
  if (!b.firstBuyTs) return null;
  const exit = b.stillHolding ? (b.lastActivityTs ?? b.firstSellTs) : (b.firstSellTs ?? b.lastActivityTs);
  if (!exit || exit < b.firstBuyTs) return null;
  return exit - b.firstBuyTs;
}

/**
 * Puts one wallet into a style bucket.
 *
 * Returns null when the timing is unknown — an unclassifiable wallet is left
 * out rather than dropped into a default bucket, which would quietly inflate
 * whichever style that happened to be.
 */
export function classifyPlay(b: PlayInput, launchTs: number | null): PlayKind | null {
  const delay = entryDelay(b, launchTs);
  if (delay === null) return null;

  const held = holdSeconds(b);
  const holding = b.stillHolding;
  const sniped = delay <= config.PLAY_SNIPE_SECONDS;
  const early = delay <= config.PLAY_EARLY_SECONDS;
  const quick = held !== null && held <= config.PLAY_FLIP_SECONDS;

  // Scaling in and out is a distinct style whenever it happens, so it is
  // checked before timing — a wallet doing this is running a position, not
  // taking a shot.
  if (b.buyCount >= config.PLAY_SCALE_MIN_BUYS && b.sellCount >= config.PLAY_SCALE_MIN_SELLS) {
    return 'scale-trim';
  }

  if (sniped) return quick && !holding ? 'snipe-flip' : 'snipe-hold';
  if (early) return quick && !holding ? 'momentum-flip' : 'early-hold';
  return quick && !holding ? 'momentum-flip' : 'late-hold';
}

/**
 * Groups profitable wallets by style, richest style first.
 *
 * Only wallets that actually made money are counted. Including losers would
 * answer a different question — this is "what worked here", not "what was
 * popular here", and those diverge badly on coins where most buyers lost.
 */
export function rankPlays(buyers: PlayInput[], launchTs: number | null): PlayGroup[] {
  const groups = new Map<PlayKind, PlayInput[]>();

  for (const b of buyers) {
    if (b.profitUsd < config.PLAY_MIN_PROFIT_USD) continue;
    const kind = classifyPlay(b, launchTs);
    if (!kind) continue;
    groups.set(kind, [...(groups.get(kind) ?? []), b]);
  }

  const out: PlayGroup[] = [];
  for (const [kind, members] of groups) {
    const multiples = members.map((m) =>
      m.investedUsd > 0 ? (m.investedUsd + m.profitUsd) / m.investedUsd : 0,
    );
    const holds = members.map(holdSeconds).filter((h): h is number => h !== null);
    const best = members.reduce((a, b) => (b.profitUsd > a.profitUsd ? b : a));

    out.push({
      kind,
      wallets: members.length,
      profitUsd: members.reduce((sum, m) => sum + m.profitUsd, 0),
      medianMultiple: median(multiples),
      medianHoldSeconds: holds.length > 0 ? median(holds) : null,
      bestWallet: best.wallet,
      bestProfitUsd: best.profitUsd,
    });
  }

  return out.sort((a, b) => b.profitUsd - a.profitUsd);
}
