import type { FirstBuyer } from '../data/solanatracker.js';
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
 * The input is the first-buyer record rather than the profit leaderboard: only
 * that endpoint returns timestamps and buy/sell counts, and without them a
 * wallet cannot be placed at all. It is already fetched, so this costs no extra
 * request — but it does mean coverage is the earliest wallets, which is stated
 * on the screen rather than papered over.
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
export function entryDelay(b: FirstBuyer, launchTs: number | null): number | null {
  if (!launchTs || !b.firstBuyTs) return null;
  const delay = b.firstBuyTs - launchTs;
  // A negative delay means the launch timestamp is the pool's, not the token's,
  // which happens on migrated coins. Treat it as a snipe rather than guessing.
  return delay < 0 ? 0 : delay;
}

/** True when most of the position was never sold. */
export function stillHolding(b: FirstBuyer): boolean {
  return b.holdingTokens > 0 && b.holdingTokens / Math.max(b.heldTokens, 1) > 0.02;
}

/**
 * How long the position was actually carried.
 *
 * For a wallet that exited, this is the time to the first sell. For one that is
 * still holding it is the time to its last activity instead — trimming a sliver
 * after seven seconds and keeping the rest is not a seven-second hold, and
 * measuring it that way made the screen say "sat on it, held 7s".
 */
export function holdSeconds(b: FirstBuyer): number | null {
  if (!b.firstBuyTs) return null;
  const exit = stillHolding(b) ? (b.lastActivityTs ?? b.firstSellTs) : (b.firstSellTs ?? b.lastActivityTs);
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
export function classifyPlay(b: FirstBuyer, launchTs: number | null): PlayKind | null {
  const delay = entryDelay(b, launchTs);
  if (delay === null) return null;

  const held = holdSeconds(b);
  const holding = stillHolding(b);
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
export function rankPlays(buyers: FirstBuyer[], launchTs: number | null): PlayGroup[] {
  const groups = new Map<PlayKind, FirstBuyer[]>();

  for (const b of buyers) {
    if (b.totalPnlUsd < config.PLAY_MIN_PROFIT_USD) continue;
    const kind = classifyPlay(b, launchTs);
    if (!kind) continue;
    groups.set(kind, [...(groups.get(kind) ?? []), b]);
  }

  const out: PlayGroup[] = [];
  for (const [kind, members] of groups) {
    const multiples = members.map((m) =>
      m.totalInvestedUsd > 0 ? (m.totalInvestedUsd + m.totalPnlUsd) / m.totalInvestedUsd : 0,
    );
    const holds = members.map(holdSeconds).filter((h): h is number => h !== null);
    const best = members.reduce((a, b) => (b.totalPnlUsd > a.totalPnlUsd ? b : a));

    out.push({
      kind,
      wallets: members.length,
      profitUsd: members.reduce((sum, m) => sum + m.totalPnlUsd, 0),
      medianMultiple: median(multiples),
      medianHoldSeconds: holds.length > 0 ? median(holds) : null,
      bestWallet: best.wallet,
      bestProfitUsd: best.totalPnlUsd,
    });
  }

  return out.sort((a, b) => b.profitUsd - a.profitUsd);
}
