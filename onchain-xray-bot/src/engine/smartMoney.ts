import type { WalletPnl } from '../data/solanatracker.js';

/**
 * Rates a wallet on its lifetime record across every token it has traded.
 *
 * The bot's other screens answer "who was early on THIS coin". That question
 * has a blind spot: catching one runner is mostly luck, and a list of one-hit
 * wallets looks identical to a list of good traders. This is the correction —
 * a wallet that is up six figures across hundreds of positions is worth
 * following; one that got a single entry right is not.
 *
 * **Win rate is deliberately not the primary measure, and using it as one would
 * invert the ranking.** Memecoin trading is power-law: the wallet that prompted
 * this module is up $234k on a 38.9% win rate, because a handful of large
 * winners more than pay for a long tail of small losses. Sorting on win
 * percentage would rank a careful break-even trader above a hugely profitable
 * one. Total profit leads; consistency only breaks ties.
 */

export type SmartTier = 'elite' | 'profitable' | 'mixed' | 'losing' | 'unknown';

export interface SmartMoney {
  wallet: string;
  tier: SmartTier;
  totalPnlUsd: number;
  totalInvestedUsd: number;
  wins: number;
  losses: number;
  winPercentage: number;
  /** Lifetime return on everything they ever put in. */
  roi: number;
  /** Positions closed or open across all tokens. */
  positions: number;
}

export const TIER_META: Record<SmartTier, { label: string; icon: string; rank: number }> = {
  elite: { label: 'ELITE', icon: '🏆', rank: 0 },
  profitable: { label: 'PROFITABLE', icon: '💰', rank: 1 },
  mixed: { label: 'MIXED', icon: '➖', rank: 2 },
  losing: { label: 'LOSING', icon: '📉', rank: 3 },
  unknown: { label: 'UNRATED', icon: '·', rank: 4 },
};

/** Lifetime profit thresholds, in USD. */
const ELITE_PNL = 100_000;
const PROFITABLE_PNL = 10_000;
const LOSING_PNL = -1_000;

/**
 * A wallet with three trades and one lucky win is not a track record. Below
 * this many positions the sample is too small to call, whatever the profit.
 */
const MIN_POSITIONS = 10;

export function rateWallet(pnl: WalletPnl | null): SmartMoney | null {
  if (!pnl) return null;

  const positions = pnl.wins + pnl.losses;
  const roi = pnl.totalInvestedUsd > 0 ? pnl.totalPnlUsd / pnl.totalInvestedUsd : 0;

  const tier: SmartTier =
    positions < MIN_POSITIONS
      ? 'unknown'
      : pnl.totalPnlUsd >= ELITE_PNL
        ? 'elite'
        : pnl.totalPnlUsd >= PROFITABLE_PNL
          ? 'profitable'
          : pnl.totalPnlUsd <= LOSING_PNL
            ? 'losing'
            : 'mixed';

  return {
    wallet: pnl.wallet,
    tier,
    totalPnlUsd: pnl.totalPnlUsd,
    totalInvestedUsd: pnl.totalInvestedUsd,
    wins: pnl.wins,
    losses: pnl.losses,
    winPercentage: pnl.winPercentage,
    roi,
    positions,
  };
}

/** True for wallets whose record is strong enough to be worth following. */
export function isSmartMoney(s: SmartMoney | null | undefined): boolean {
  return s?.tier === 'elite' || s?.tier === 'profitable';
}

/**
 * Summarises how much proven money is in a coin.
 *
 * Several independently profitable wallets buying the same coin early is a far
 * stronger signal than any single wallet's entry, and it is the one thing this
 * bot can say that a block explorer cannot.
 */
export function summariseSmartMoney(ratings: (SmartMoney | null)[]): {
  smart: number;
  rated: number;
  elite: number;
  combinedPnlUsd: number;
} {
  const rated = ratings.filter((r): r is SmartMoney => r !== null && r.tier !== 'unknown');
  const smart = rated.filter(isSmartMoney);
  return {
    smart: smart.length,
    rated: rated.length,
    elite: rated.filter((r) => r.tier === 'elite').length,
    combinedPnlUsd: smart.reduce((sum, r) => sum + r.totalPnlUsd, 0),
  };
}

/**
 * Builds a lifetime rating from a wallet's per-token results.
 *
 * Derived from the same request the repeat-win check already makes, rather
 * than a second call to the summary endpoint. Two lookups per wallet doubled
 * the slowest phase of the scan for data that was already in hand.
 */
export function rateFromTokenResults(
  wallet: string,
  results: { profitUsd: number; investedUsd: number }[],
): SmartMoney | null {
  if (results.length === 0) return null;

  let totalPnl = 0;
  let totalInvested = 0;
  let wins = 0;
  let losses = 0;
  for (const r of results) {
    totalPnl += r.profitUsd;
    totalInvested += r.investedUsd;
    if (r.profitUsd > 0) wins++;
    else if (r.profitUsd < 0) losses++;
  }

  return rateWallet({
    wallet,
    realizedUsd: totalPnl,
    unrealizedUsd: 0,
    totalPnlUsd: totalPnl,
    totalInvestedUsd: totalInvested,
    wins,
    losses,
    winPercentage: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
    averageBuyUsd: results.length > 0 ? totalInvested / results.length : 0,
  });
}
