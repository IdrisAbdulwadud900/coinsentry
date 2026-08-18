import { config } from '../config.js';
import type { WalletLedger, EarlyBuyer, DiamondHand, EntryTier } from '../types/domain.js';

export interface TierContext {
  floorMcap: number;
  floorBandMax: number;
  firstTradeTs: number;
  totalSupply: number;
}

/**
 * Classifies how good a wallet's entry was.
 *
 * Two ideas are deliberately kept separate:
 *  - `floor`   is relative to THIS coin — it caught the actual bottom, whatever
 *              that happened to be. A coin whose floor was $40k has a floor
 *              band far above $10k, and those buyers were still first in.
 *  - `sub10k`  is the absolute rule ("got in under $10k market cap").
 * A coin that launched above the absolute threshold would otherwise show no
 * early buyers at all, which would be misleading rather than accurate.
 */
export function classifyEntry(entryMcap: number, ctx: TierContext): EntryTier {
  if (entryMcap <= 0) return 'late';
  if (entryMcap <= ctx.floorBandMax) return 'floor';
  if (entryMcap <= config.EARLY_MCAP_USD) return 'sub10k';
  if (entryMcap <= Math.max(ctx.floorBandMax * 3, config.EARLY_MCAP_USD * 3)) return 'early';
  return 'late';
}

/**
 * Smallest position worth showing, scaled to the coin.
 *
 * A flat dollar bar is wrong at both ends. $50 is a ~0.5% stake on a coin whose
 * floor was $9k — filtering out precisely the early buyers this bot exists to
 * find — and it is pure dust on one whose floor was $5M. Expressing the bar as
 * a share of the floor market cap makes it mean roughly "acquired at least this
 * much of the coin", which is the thing that actually matters and holds at any
 * scale.
 *
 * The absolute value is retained only as a sanity floor, so a micro-cap launch
 * does not surface cent-sized test buys.
 */
export function minPositionUsd(floorMcap: number): number {
  const scaled = floorMcap > 0 ? floorMcap * (config.MIN_POSITION_FLOOR_PCT / 100) : 0;
  return Math.max(config.MIN_POSITION_USD, scaled);
}

export const TIER_META: Record<EntryTier, { label: string; icon: string; rank: number }> = {
  floor: { label: 'FLOOR', icon: '🎯', rank: 0 },
  sub10k: { label: 'SUB-10K', icon: '🟢', rank: 1 },
  early: { label: 'EARLY', icon: '🔵', rank: 2 },
  late: { label: 'LATE', icon: '⚪', rank: 3 },
};

export type EntrySort = 'earliest' | 'biggest' | 'profit';

/**
 * The band that actually contains the earliest buyers.
 *
 * The coin's floor is the lowest price ever printed, and that print is often a
 * sell — liquidity being seeded, or an opening dump — at a level no buyer could
 * reach. One BNB Chain token opened with a sell at $7.4k while its lowest real
 * buy was $19.8k, so a band of $7.4k-$13k contained nobody and the screen came
 * back empty on a token with 1,649 buyers.
 *
 * So the band is rebased onto the lowest genuine entry whenever the price-based
 * one holds no one. The floor itself is left alone — it is a true fact about the
 * coin — but "who got in near the bottom" is answered against the bottom that
 * was actually buyable.
 */
export function resolveEntryBand(
  ledgers: Map<string, WalletLedger>,
  ctx: TierContext,
): { floorMcap: number; floorBandMax: number; rebased: boolean } {
  const minPos = minPositionUsd(ctx.floorMcap);
  const entries = [...ledgers.values()]
    .filter((l) => l.buyCount > 0 && l.entryMcap > 0 && l.totalBoughtUsd >= minPos)
    .map((l) => l.entryMcap);

  if (entries.length === 0) {
    return { floorMcap: ctx.floorMcap, floorBandMax: ctx.floorBandMax, rebased: false };
  }

  const lowestEntry = Math.min(...entries);
  if (lowestEntry <= ctx.floorBandMax) {
    return { floorMcap: ctx.floorMcap, floorBandMax: ctx.floorBandMax, rebased: false };
  }

  return {
    floorMcap: lowestEntry,
    floorBandMax: lowestEntry * config.FLOOR_BAND_MULT,
    rebased: true,
  };
}

/**
 * Wallets that entered in the floor range or under the absolute early cap,
 * ordered by whichever lens the user picked.
 */
export function findEarlyBuyers(
  ledgers: Map<string, WalletLedger>,
  ctx: TierContext,
  sort: EntrySort = 'earliest',
): EarlyBuyer[] {
  const buyers = [...ledgers.values()].filter((l) => l.buyCount > 0 && l.firstBuyTs > 0);

  // Entry rank is over every buyer, so "#3 in" keeps its meaning after filtering.
  const byTime = [...buyers].sort((a, b) => a.firstBuyTs - b.firstBuyTs);
  const rankOf = new Map<string, number>();
  byTime.forEach((l, i) => rankOf.set(l.wallet, i + 1));

  const minPos = minPositionUsd(ctx.floorMcap);
  // Judge entries against the band that real buyers could reach.
  const band = resolveEntryBand(ledgers, ctx);
  const bandCtx: TierContext = { ...ctx, floorMcap: band.floorMcap, floorBandMax: band.floorBandMax };

  const out: EarlyBuyer[] = [];
  for (const ledger of buyers) {
    if (ledger.totalBoughtUsd < minPos) continue;
    const tier = classifyEntry(ledger.entryMcap, bandCtx);
    if (tier === 'late' || tier === 'early') continue;
    out.push({
      ledger,
      tier,
      entryRank: rankOf.get(ledger.wallet) ?? 0,
      secondsAfterLaunch: Math.max(0, ledger.firstBuyTs - ctx.firstTradeTs),
      supplyPct: ctx.totalSupply > 0 ? (ledger.totalBoughtTokens / ctx.totalSupply) * 100 : 0,
    });
  }

  return sortEarlyBuyers(out, sort);
}

export function sortEarlyBuyers(list: EarlyBuyer[], sort: EntrySort): EarlyBuyer[] {
  const sorted = [...list];
  switch (sort) {
    case 'biggest':
      sorted.sort((a, b) => b.supplyPct - a.supplyPct || a.ledger.entryMcap - b.ledger.entryMcap);
      break;
    case 'profit':
      sorted.sort((a, b) => b.ledger.totalPnlUsd - a.ledger.totalPnlUsd);
      break;
    default:
      sorted.sort(
        (a, b) =>
          TIER_META[a.tier].rank - TIER_META[b.tier].rank ||
          a.ledger.entryMcap - b.ledger.entryMcap ||
          a.ledger.firstBuyTs - b.ledger.firstBuyTs,
      );
  }
  return sorted;
}

/**
 * Early entrants who then actually held.
 *
 * The bar is the multiple the coin reached BEFORE the wallet's first sell —
 * not what they realized. A wallet that entered at the floor and watched it run
 * 40x before trimming showed conviction, even if it eventually sold lower; a
 * wallet that flipped at 1.2x did not, whatever its final PnL says.
 */
export function findDiamondHands(
  ledgers: Map<string, WalletLedger>,
  ctx: TierContext,
  minBucket = config.diamondBuckets[0] ?? 3,
): DiamondHand[] {
  const buckets = config.diamondBuckets;
  const minPos = minPositionUsd(ctx.floorMcap);
  const band = resolveEntryBand(ledgers, ctx);
  const bandCtx: TierContext = { ...ctx, floorMcap: band.floorMcap, floorBandMax: band.floorBandMax };
  const out: DiamondHand[] = [];

  for (const ledger of ledgers.values()) {
    if (ledger.buyCount === 0 || ledger.totalBoughtUsd < minPos) continue;

    const tier = classifyEntry(ledger.entryMcap, bandCtx);
    // The user's rule: early entry is a precondition, not a bonus.
    if (tier !== 'floor' && tier !== 'sub10k') continue;

    // A wallet that bought and sold within seconds did not ride anything — it
    // just happened to be open while the price moved. Without this, a
    // same-block flipper inherits the surrounding spike and outranks people who
    // actually held.
    if (
      ledger.holdSeconds !== null &&
      ledger.holdSeconds < config.DIAMOND_MIN_HOLD_SECONDS
    ) {
      continue;
    }

    // Wallets still holding are judged on the run so far, which is at least as
    // strong a signal as one that already took profit.
    const achieved = ledger.stillHolding
      ? Math.max(ledger.heldMultiple, ledger.currentMultiple)
      : ledger.heldMultiple;

    if (!Number.isFinite(achieved) || achieved < minBucket) continue;

    let bucket = 0;
    for (const b of buckets) if (achieved >= b) bucket = b;
    if (bucket === 0) continue;

    out.push({
      ledger,
      bucket,
      entryTier: tier,
      supplyPct: ctx.totalSupply > 0 ? (ledger.totalBoughtTokens / ctx.totalSupply) * 100 : 0,
    });
  }

  out.sort(
    (a, b) =>
      b.bucket - a.bucket ||
      b.ledger.totalPnlUsd - a.ledger.totalPnlUsd ||
      a.ledger.entryMcap - b.ledger.entryMcap,
  );
  return out;
}
