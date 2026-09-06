import type { FirstBuyer } from '../data/solanatracker.js';
import type { ProviderEntry } from '../types/domain.js';
import { config } from '../config.js';
import { classifyEntry, minPositionUsd, type TierContext } from './entries.js';
import type { PriceCurve } from './priceCurve.js';

/**
 * Builds the early-buyer list from SolanaTracker's precomputed first-buyers.
 *
 * This exists because walking a token's signatures back to its launch is not
 * feasible for the coins that matter: a pump.fun launch can pass 120,000
 * transactions within hours, so our own replay reaches only recent activity and
 * the earliest buyers — the entire question — fall outside it. The provider
 * answers that in one request.
 *
 * Each record carries the wallet's FIRST buy in both tokens and USD, so the
 * entry price — and therefore the entry market cap — is exact and tierable.
 *
 * The records carry no per-trade history, so the highest price a wallet rode
 * before selling cannot come from them. It comes instead from candle highs,
 * which cover the token's whole life, combined with the wallet's own first-buy
 * and first-sell timestamps. Where candles do not reach, `heldMultiple` stays
 * zero rather than being estimated: that number is the entire basis of a
 * conviction claim, and a guessed one would be worse than none.
 */
export function buildProviderEntries(
  buyers: FirstBuyer[],
  ctx: TierContext,
  currentPriceUsd: number,
  curve?: PriceCurve,
): ProviderEntry[] {
  if (buyers.length === 0) return [];

  const minPos = minPositionUsd(ctx.floorMcap);

  // Entry rank is over every buyer the provider returned, before filtering, so
  // "#3 in" keeps its meaning.
  const ordered = [...buyers]
    .filter((b) => b.firstBuyTs !== null)
    .sort((a, b) => (a.firstBuyTs ?? 0) - (b.firstBuyTs ?? 0));
  const rankOf = new Map<string, number>();
  ordered.forEach((b, i) => rankOf.set(b.wallet, i + 1));

  const out: ProviderEntry[] = [];

  for (const b of buyers) {
    if (b.entryTokens <= 0 || b.entryUsd <= 0) continue;

    const entryPriceUsd = b.entryUsd / b.entryTokens;
    if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) continue;

    const entryMcap = entryPriceUsd * ctx.totalSupply;
    const tier = classifyEntry(entryMcap, ctx);
    if (tier === 'late' || tier === 'early') continue;

    // Position size is judged on what they actually committed, using the same
    // coin-scaled bar as the rest of the bot.
    const invested = b.totalInvestedUsd > 0 ? b.totalInvestedUsd : b.entryUsd;
    if (invested < minPos) continue;

    const avgSellPrice = b.soldTokens > 0 ? b.totalSoldUsd / b.soldTokens : 0;

    // The provider's own `cost_basis` field is NOT a per-token price in the
    // same units as everything else — measured against a real record it came
    // out ~3000x too high, which rendered a wallet that tripled its money as
    // "0.00x". Derive the average buy price from figures whose units are
    // unambiguous, and fall back to the first-buy price rather than that field.
    const derivedBasis = b.heldTokens > 0 ? b.totalInvestedUsd / b.heldTokens : 0;
    const basis = derivedBasis > 0 ? derivedBasis : entryPriceUsd;

    // How far the coin ran between their entry and their first sell. Only
    // meaningful with candle coverage, which spans the token's whole life;
    // without it the replay window would understate the peak and quietly
    // demote wallets that did hold.
    const windowEnd = b.firstSellTs ?? Math.floor(Date.now() / 1000);
    // Compare against null explicitly: a timestamp of 0 is a real value, and a
    // truthiness check would silently treat it as a missing one.
    const peak =
      curve?.hasCandles && b.firstBuyTs !== null ? curve.peak(b.firstBuyTs, windowEnd) : 0;
    const heldMultiple = peak > 0 && entryMcap > 0 ? peak / entryMcap : 0;

    out.push({
      wallet: b.wallet,
      tier,
      entryMcap,
      entryPriceUsd,
      entryTs: b.firstBuyTs ?? 0,
      entryRank: rankOf.get(b.wallet) ?? 0,
      secondsAfterLaunch: Math.max(0, (b.firstBuyTs ?? 0) - ctx.firstTradeTs),
      investedUsd: invested,
      soldUsd: b.totalSoldUsd,
      totalPnlUsd: b.totalPnlUsd,
      holdingTokens: b.holdingTokens,
      // Supply that left without a sale. A wallet showing a good entry, no
      // sells and an empty balance did not walk away from the position — it
      // handed it to another address, which is the pattern the relay screen
      // exists to catch and which no amount of provider PnL will show.
      movedOutTokens: Math.max(0, b.heldTokens - b.soldTokens - b.holdingTokens),
      everHeldTokens: b.heldTokens,
      supplyPct: ctx.totalSupply > 0 ? (b.heldTokens / ctx.totalSupply) * 100 : 0,
      buyCount: b.buyCount,
      sellCount: b.sellCount,
      holdSeconds:
        b.firstSellTs !== null && b.firstBuyTs !== null ? b.firstSellTs - b.firstBuyTs : null,
      // "Still holding" needs a real position, not dust left behind by a sale.
      stillHolding: b.holdingTokens > 0 && b.holdingTokens / Math.max(b.heldTokens, 1) > 0.02,
      realizedMultiple: basis > 0 && avgSellPrice > 0 ? avgSellPrice / basis : 0,
      currentMultiple: entryPriceUsd > 0 ? currentPriceUsd / entryPriceUsd : 0,
      heldMultiple,
      peakMcapBeforeFirstSell: peak,
    });
  }

  out.sort(
    (a, b) => a.entryMcap - b.entryMcap || a.entryTs - b.entryTs,
  );
  return out;
}

/**
 * Diamond hands drawn from the provider's first-buyer records.
 *
 * The replay-based version can only judge wallets it actually saw trade, which
 * on a busy token is nobody from the launch — so that screen came back empty on
 * precisely the coins worth asking about. These records carry each wallet's
 * first buy and first sell, and candle highs supply what happened in between,
 * which is enough to apply the same test: entered early, then rode a real
 * multiple before taking anything off.
 *
 * Wallets whose hold window is too short for the candle resolution have no
 * measurable run and are excluded rather than assumed — an unmeasured wallet is
 * not a patient one.
 */
export function findProviderDiamondHands(entries: ProviderEntry[]): ProviderEntry[] {
  const buckets = config.diamondBuckets;
  const floor = buckets[0] ?? 3;

  return entries
    .filter((e) => {
      // A same-block flip inherits nothing, however far the coin later ran.
      if (e.holdSeconds !== null && e.holdSeconds < config.DIAMOND_MIN_HOLD_SECONDS) return false;
      const achieved = e.stillHolding ? Math.max(e.heldMultiple, e.currentMultiple) : e.heldMultiple;
      return Number.isFinite(achieved) && achieved >= floor;
    })
    .sort((a, b) => {
      const av = a.stillHolding ? Math.max(a.heldMultiple, a.currentMultiple) : a.heldMultiple;
      const bv = b.stillHolding ? Math.max(b.heldMultiple, b.currentMultiple) : b.heldMultiple;
      return bv - av || b.totalPnlUsd - a.totalPnlUsd;
    });
}

/** Largest configured bucket this entry cleared, or 0. */
export function providerBucket(e: ProviderEntry): number {
  const achieved = e.stillHolding ? Math.max(e.heldMultiple, e.currentMultiple) : e.heldMultiple;
  let bucket = 0;
  for (const b of config.diamondBuckets) if (achieved >= b) bucket = b;
  return bucket;
}

/**
 * Early wallets that moved part of their position out without selling it.
 *
 * The source half of a supply relay, and the only half the provider's records
 * can show. On a coin too large to replay, this is the difference between
 * saying "not searched" and naming the wallets worth looking at — but where the
 * supply went is genuinely unknown here, so the UI must not call it a relay.
 *
 * A trickle is ignored: dust left behind by a full exit is not a transfer out.
 */
export function movedSupplyOut(entries: ProviderEntry[]): ProviderEntry[] {
  return entries
    .filter(
      (e) =>
        e.movedOutTokens > 0 &&
        e.everHeldTokens > 0 &&
        e.movedOutTokens / e.everHeldTokens > 0.02,
    )
    .sort((a, b) => b.movedOutTokens - a.movedOutTokens);
}
