import type { Logger } from "pino";
import type { TokenRepo } from "../data/tokenRepo.js";
import type { SnapshotRepo } from "../data/snapshotRepo.js";
import type { AlertRepo } from "../data/alertRepo.js";
import type { DiscoveryStateRepo } from "../data/discoveryStateRepo.js";
import type { ChainClient } from "../data/chainClient.js";
import {
  readGraduationStatuses,
  readPoolMarketCaps,
  readTokenBalance,
  readTotalSupply,
  readEarlyBuyConcentration,
} from "../data/chainClient.js";
import { DexScreenerClient, indexPairsByToken, pickCanonicalPair, toMarketSnapshot } from "../data/dexscreener.js";
import { runDiscovery, type FactoryConfig } from "../data/tokenDiscovery.js";
import {
  ageHours,
  computeBaseline,
  isInCooldown,
  meetsDeadCriteria,
  meetsRevivalCriteria,
  meetsEarlyMomentumCriteria,
  meetsMomentumReAlertCriteria,
  meetsBreakoutCriteria,
  meetsReversalCriteria,
  type ClassifierConfig,
} from "./classifier.js";
import {
  buildRevivalAlertHtml,
  buildGraduationAlertHtml,
  buildMarketCapAlertHtml,
  buildMomentumAlertHtml,
  buildPerformanceMilestoneAlertHtml,
  buildDemotionAlertHtml,
  buildBreakoutAlertHtml,
  buildDumpWarningAlertHtml,
  resolveMarketCapUsd,
  type DevStatus,
  type EarlyBuyConcentration,
} from "./alertMessages.js";
import type { SettingsRepo } from "../data/settingsRepo.js";
import type { Notifier } from "./notifier.js";
import type { TokenRow, MarketSnapshot } from "../types/domain.js";
import type { EthPriceClient } from "../data/ethPrice.js";
import { BlockscoutClient, computeHolderConcentration, type HolderConcentration } from "../data/blockscoutClient.js";
import { hasOnChainIntegrations, DEFAULT_CHAIN } from "../data/chains.js";
import type { SolanaClient, SolanaMintSafety } from "../data/solanaClient.js";
import { runMultiChainDiscovery } from "../data/multiChainDiscovery.js";
import { runDexPoolDiscovery, type ChainPoolConfig } from "../data/dexPoolDiscovery.js";
import { runSolanaDiscovery } from "../data/solanaDiscovery.js";
import type { JupiterClient } from "../data/jupiterClient.js";
import type { XSearchClient, XMention } from "../data/xSearchClient.js";
import type { DexPair } from "../types/dexscreener.js";
import type { OutcomeRepo, AlertOutcomeRow } from "../data/outcomeRepo.js";

/** How many prior snapshots (since a token became dead) feed the trailing-median baseline. */
const BASELINE_SAMPLE_LIMIT = 12;

/**
 * Hard ceiling (USD) on the market cap at which ANY alert may first fire — the owner's
 * explicit rule (2026-08-30): the target is coins gaining volume at low caps ($3k-$7k
 * especially), and anything above $20k is out of scope entirely. One cap for every signal;
 * this replaced a split scheme ($11k for entries, $250k for breakouts/momentum) because
 * the split let breakout alerts fire on $50k-$100k coins the owner does not trade.
 * Performance-milestone (10x/100x/1000x) and demotion alerts remain exempt, since those
 * track a position *after* a sub-cap entry.
 */
const MAX_ALERT_MARKET_CAP_USD = 20_000;

/** Ceiling for the entry-gate bundle cap — the owner's hard rule: never alert on a coin
 * whose top-5 early-buyer ("bundle") concentration exceeds 60%. The observer may
 * auto-TIGHTEN the effective cap below this (never loosen it) based on real
 * winners-vs-dumpers outcomes; see autoTuneBundleCap. */
const MAX_BUNDLE_CAP_PCT = 60;

/** Floor the auto-tuner can never tighten past, so a few unlucky samples can't choke
 * off alerts entirely. */
const MIN_BUNDLE_CAP_PCT = 35;

/** settings-table key holding the observer's auto-tuned bundle cap override. */
export const BUNDLE_CAP_SETTING_KEY = "observer_bundle_cap_pct";

/** settings-table key holding the chain the bot is focused on, if any. */
export const FOCUS_CHAIN_SETTING_KEY = "focus_chain";

/**
 * The chains actually being worked this cycle.
 *
 * Focus mode trades breadth for depth: with one chain selected, the whole scan budget,
 * discovery effort and request quota go to it, so its coins are revisited far more often
 * and far less is missed there. Returns the configured set when no focus is set.
 */
export function activeChains(deps: { settingsRepo: SettingsRepo; enabledChains: string[] }): string[] {
  const focus = deps.settingsRepo.get(FOCUS_CHAIN_SETTING_KEY);
  if (focus && deps.enabledChains.includes(focus)) return [focus];
  return deps.enabledChains;
}

/** The effective bundle cap: the observer's auto-tuned override when one is stored,
 * clamped to [MIN_BUNDLE_CAP_PCT, MAX_BUNDLE_CAP_PCT], else the 60% ceiling. */
export function effectiveBundleCapPct(settingsRepo: SettingsRepo): number {
  const raw = Number(settingsRepo.get(BUNDLE_CAP_SETTING_KEY));
  if (!Number.isFinite(raw)) return MAX_BUNDLE_CAP_PCT;
  return Math.min(MAX_BUNDLE_CAP_PCT, Math.max(MIN_BUNDLE_CAP_PCT, raw));
}

/** Minimum 1h buy count before a zero-sell hour is treated as a honeypot signal — below
 * this, zero sells is just a quiet token, not evidence nobody *can* sell. */
const HONEYPOT_MIN_BUYS_1H = 15;

/** Universal tradability floor for every entry alert, links or not. Measured against 192
 * resolved alerts, 186 already cleared it — so it costs virtually no coverage while
 * blocking coins that are not realistically enterable or exitable. */
const MIN_ALERT_LIQUIDITY_USD = 1_000;
const MIN_ALERT_BUYS_1H = 5;

/**
 * Coins younger than this are never alerted on. The owner's strategy is explicitly not new
 * pairs any more: the target is an established coin that people suddenly start bidding, so
 * a launch that is minutes old is noise regardless of how good its numbers look. This is a
 * hard floor applied to every alert path, including breakouts.
 */
/**
 * Minimum age before a coin may alert. Zero means new pairs are in scope again.
 *
 * This was 60 while the strategy was "established coins being suddenly bid, not new
 * pairs". The goal has since widened to catching anything with volume — sub-$10k lowcaps
 * and fresh ~$10k pairs alike — so an age floor now excludes half of what is wanted. The
 * quality gates that actually matter (liquidity, live buyers, honeypot and bundle checks)
 * are unaffected and still apply to every coin.
 */
const MIN_ALERT_AGE_MINUTES = 0;

/** Liquidity and 1h-buy floors a link-less coin must clear to qualify without links
 * (see hasStrongTraction). Set well above the $200 discovery floor so this is a genuine
 * traction bar, not a loophole that lets the spam farm back in. */
const LINKLESS_MIN_LIQUIDITY_USD = 1_200;
// 25 was set against new-pair launch activity and is far too high for the coins now
// targeted: "no website or social links" is the single largest block reason in production
// (4,330 coins in three hours), and of ~1,800 coins scanned per hour only about 64 have a
// single buy and 9-10 reach 30 buys. Requiring 25 put the bar near the very top of the
// distribution, so a coin turning up off its floor almost never cleared it. The completed
// -sell requirement below is what actually proves the token is sellable, and that stays.
const LINKLESS_MIN_BUYS_1H = 12;

/** How often the fast lane rechecks young 'unindexed' tokens (vs. UNINDEXED_RECHECK_HOURS
 * for old ones) so brand-new pairs get promoted while their momentum window is still open. */
const YOUNG_UNINDEXED_RECHECK_MS = 5 * 60 * 1000;

/**
 * Pre-send quality gate shared by ALL alerts, breakouts and momentum included. Returns a
 * human-readable reason to skip the alert, or null when the alert may fire. Checks:
 * 1. Market cap must be known and at most MAX_ALERT_MARKET_CAP_USD ($20k) — one universal
 *    ceiling, per the owner: lowcaps gaining volume are the whole target, and anything
 *    above $20k is out of scope no matter which signal spotted it.
 * 2. Liquidity/buys floors, honeypot heuristic, and the links-or-traction rule below.
 */
function entryAlertBlockReason(
  marketCapUsd: number | null,
  snapshot: Pick<MarketSnapshot, "websiteUrl" | "socials" | "buys1h" | "sells1h" | "liquidityUsd"> | null | undefined,
  ageMinutes: number | null
): string | null {
  const maxMarketCapUsd = MAX_ALERT_MARKET_CAP_USD;
  if (ageMinutes != null && ageMinutes < MIN_ALERT_AGE_MINUTES) {
    return `only ${Math.round(ageMinutes)}m old — below the ${MIN_ALERT_AGE_MINUTES}m minimum age`;
  }
  if (marketCapUsd == null) return "market cap unknown";
  if (marketCapUsd > maxMarketCapUsd) {
    return `market cap $${Math.round(marketCapUsd)} above the $${maxMarketCapUsd} entry cap`;
  }
  if (!snapshot) return "no DexScreener data yet (links unknown)";

  // Universal tradability floor, applied to every coin regardless of links.
  // Links prove who made a coin, not that it can be bought or sold — and previously
  // having links exempted a coin from any activity requirement at all. That let through
  // coins with $59 of liquidity, and coins drifting across a market-cap tier on one buy
  // per hour: not tradable positions at any price.
  const liquidityUsd = snapshot.liquidityUsd ?? 0;
  if (liquidityUsd < MIN_ALERT_LIQUIDITY_USD) {
    return `liquidity $${Math.round(liquidityUsd)} below the $${MIN_ALERT_LIQUIDITY_USD} floor — not tradable`;
  }
  const buys1h = snapshot.buys1h ?? 0;
  if (buys1h < MIN_ALERT_BUYS_1H) {
    return `only ${buys1h} buys in the last hour — no live demand`;
  }

  if (buys1h >= HONEYPOT_MIN_BUYS_1H && snapshot.sells1h === 0) {
    return `possible honeypot: ${buys1h} buys but zero sells (1h)`;
  }

  if (!snapshot.websiteUrl && snapshot.socials.length === 0 && !hasStrongTraction(snapshot)) {
    return "no website or social links, and traction too thin to qualify without them";
  }
  return null;
}

/**
 * True when a reported market cap is actually supported by the pool behind it.
 *
 * Market cap is derived from pool price, so once liquidity is drained the figure stops
 * meaning anything: a real coin was observed reporting a $66,194 market cap against
 * **$0.02** of liquidity, and its recorded all-time high reached $66 billion. Readings
 * like that are not merely bad alerts — they poison ATH, peak multiple, and the
 * winner/dumper classification the observer learns from.
 *
 * Unknown liquidity counts as untrustworthy rather than being assumed fine.
 */
function isMarketCapTrustworthy(marketCapUsd: number | null, liquidityUsd: number | null, minPct: number): boolean {
  if (marketCapUsd == null || marketCapUsd <= 0) return false;
  // A liquidity ratio alone cannot catch everything: a spoofed pool can report a $43bn
  // market cap against $1.7bn of "liquidity", which is a perfectly healthy-looking 4% and
  // sails through the ratio test while being complete fiction. This bot only ever enters
  // below $11k, so a figure larger than a mid-cap public company is self-evidently not a
  // real reading — and letting one through poisons ATH, peak multiple, milestone alerts
  // and the observer's winner/dumper labels at once.
  if (marketCapUsd > MAX_PLAUSIBLE_MARKET_CAP_USD) return false;
  if (liquidityUsd == null || liquidityUsd <= 0) return false;
  return (liquidityUsd / marketCapUsd) * 100 >= minPct;
}

/** Ceiling above which a reported market cap is treated as fabricated rather than real.
 * Observed in production: RTL-override scam tokens reporting tens of billions. */
const MAX_PLAUSIBLE_MARKET_CAP_USD = 100_000_000;

/** Gate reason when a market cap isn't backed by real liquidity, or null when it is. */
function untrustworthyMarketCapReason(
  deps: PollerDeps,
  marketCapUsd: number | null,
  liquidityUsd: number | null
): string | null {
  if (isMarketCapTrustworthy(marketCapUsd, liquidityUsd, deps.minLiquidityToMcapPct)) return null;
  return `market cap $${Math.round(marketCapUsd ?? 0)} unsupported by only $${Math.round(liquidityUsd ?? 0)} liquidity`;
}

/**
 * Escape hatch for the links requirement, using only data already on the snapshot (no
 * extra network calls).
 *
 * The links rule exists to filter anonymous spam-farm launches, and it does that well on
 * chains discovered via DexScreener's profile feeds (where links are guaranteed). On
 * Pons/Robinhood, though, listing a website or social is entirely optional and most real
 * coins never do — measured against production data, that single rule blocked 686 coins
 * that went on to exceed $25k, including one that reached $516k.
 *
 * So a link-less coin can still qualify by proving itself with real trading instead:
 * meaningful liquidity, a genuine crowd of buyers, and at least one completed sell (which
 * also demonstrates the token is actually sellable). Spam with no links and no traction
 * stays blocked exactly as before.
 */
function hasStrongTraction(
  snapshot: Pick<MarketSnapshot, "buys1h" | "sells1h" | "liquidityUsd">
): boolean {
  const liquidityUsd = snapshot.liquidityUsd ?? 0;
  const buys1h = snapshot.buys1h ?? 0;
  // A null sell count means "unknown", which can't prove sellability — only a real,
  // observed sell counts here.
  const sells1h = snapshot.sells1h;
  return (
    liquidityUsd >= LINKLESS_MIN_LIQUIDITY_USD && buys1h >= LINKLESS_MIN_BUYS_1H && sells1h != null && sells1h >= 1
  );
}

/** Tighter bundle ceiling for brand-new pairs. A launch is exactly when a team can hand
 * itself the supply, and it is the one moment the concentration reading is unambiguous —
 * so new pairs are held to a stricter standard than coins that have been trading a while. */
const NEW_PAIR_BUNDLE_CAP_PCT = 50;

/** The bundle ceiling that applies to this token right now. */
function bundleCapFor(deps: PollerDeps, token: TokenRow, now: number): number {
  const age = alertAgeMinutes(token, now);
  const standard = effectiveBundleCapPct(deps.settingsRepo);
  const isNewPair = age != null && age < NEW_PAIR_MAX_AGE_MINUTES;
  return isNewPair ? Math.min(standard, NEW_PAIR_BUNDLE_CAP_PCT) : standard;
}

/** True when the early-buy ("bundle") concentration is known and above the cap that
 * applies to this token. */
function isOverBundleLimit(
  deps: PollerDeps,
  earlyBuy: EarlyBuyConcentration | null,
  token?: TokenRow,
  now?: number
): boolean {
  if (earlyBuy == null) return false;
  const cap = token && now != null ? bundleCapFor(deps, token, now) : effectiveBundleCapPct(deps.settingsRepo);
  return earlyBuy.top5Pct > cap;
}

/** Human-readable skip reason for a bundle-cap block, showing the cap that applied. */
function bundleBlockReason(deps: PollerDeps, earlyBuy: EarlyBuyConcentration, token?: TokenRow, now?: number): string {
  const cap = token && now != null ? bundleCapFor(deps, token, now) : effectiveBundleCapPct(deps.settingsRepo);
  return `bundle concentration ${earlyBuy.top5Pct.toFixed(0)}% above the ${cap}% cap`;
}

/**
 * One-token DexScreener lookup used by fast-path alert sites (tier crossings, fast-path
 * graduations) that otherwise work purely on-chain and would have no links/image/sell data
 * to feed the entry gate. Only called at the moment an alert is about to fire, never per
 * poll tick. Returns null when the token isn't indexed yet or the lookup fails.
 */
async function fetchSnapshotForToken(deps: PollerDeps, token: TokenRow): Promise<MarketSnapshot | null> {
  try {
    const pairs = await deps.dex.lookupBatch(token.chain, [token.address]);
    const pair = pickCanonicalPair(indexPairsByToken(pairs), token.address);
    return pair ? toMarketSnapshot(pair, token.address) : null;
  } catch (err) {
    deps.logger.warn({ address: token.address, err: String(err) }, "Single-token snapshot lookup failed");
    return null;
  }
}

/**
 * Batch-resolves market data for a set of tokens that may span several chains, issuing
 * one DexScreener request set per chain and merging the results into a single
 * address-keyed index (the same shape `indexPairsByToken` produces), so every existing
 * per-token loop keeps working unchanged. A failure on one chain is logged and skipped
 * rather than losing the whole cycle's data.
 */
async function lookupPairsAcrossChains(deps: PollerDeps, tokens: TokenRow[]): Promise<Map<string, DexPair[]>> {
  const byChain = new Map<string, string[]>();
  for (const token of tokens) {
    const chain = token.chain || deps.dexScreenerChainId;
    const list = byChain.get(chain);
    if (list) list.push(token.address);
    else byChain.set(chain, [token.address]);
  }

  const merged = new Map<string, DexPair[]>();
  for (const [chain, addresses] of byChain) {
    try {
      const pairs = await deps.dex.lookupBatch(chain, addresses);
      for (const [key, value] of indexPairsByToken(pairs)) {
        const existing = merged.get(key);
        if (existing) existing.push(...value);
        else merged.set(key, value);
      }
    } catch (err) {
      deps.logger.error({ chain, err: String(err) }, "Market data lookup failed for chain, skipping it this cycle");
    }
  }
  return merged;
}

/** DexScreener hosts token images at a stable CDN path even when the pair payload omits
 * `info.imageUrl` (its metadata indexing lags). Tokens with no uploaded image 404 here,
 * which the notifier's candidate loop simply treats as "try the next source". */
function dexScreenerCdnImageUrl(chainId: string, tokenAddress: string): string {
  return `https://dd.dexscreener.com/ds-data/tokens/${chainId}/${tokenAddress.toLowerCase()}.png?size=lg`;
}

/**
 * Assembles the ordered image-candidate list for an alert: the live snapshot's image,
 * then the cached DB image, then (only when neither exists) Blockscout's token icon —
 * cached back to the DB once found — and finally DexScreener's constructed CDN URL as a
 * last-resort guess. The notifier tries each until one sends, so an alert shows an image
 * whenever ANY source actually has one.
 */
async function buildAlertImageCandidates(
  deps: PollerDeps,
  token: TokenRow,
  snapshotImageUrl?: string | null
): Promise<string[]> {
  const candidates: string[] = [];
  const push = (url: string | null | undefined): void => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  push(snapshotImageUrl);
  push(token.image_url);
  if (candidates.length === 0) {
    try {
      // Chain-aware: uses that chain's Blockscout instance, and simply skips the step
      // for chains without one rather than querying the wrong explorer.
      const icon = (await deps.blockscoutByChain[token.chain]?.fetchTokenIconUrl(token.address)) ?? null;
      if (icon) {
        deps.tokenRepo.setImageUrlIfMissing(token.address, icon);
        push(icon);
      }
    } catch (err) {
      deps.logger.warn({ address: token.address, err: String(err) }, "Blockscout icon lookup failed, continuing without it");
    }
  }
  push(dexScreenerCdnImageUrl(token.chain, token.address));
  return candidates;
}

/** A coin whose peak multiple since alert reaches this is classified a 'winner'. */
const WINNER_MIN_PEAK_MULTIPLE = 2;

/**
 * Tokens whose market data is fetched and processed together, and the single number that
 * decides this process's peak memory.
 *
 * Measured, not guessed: the process died after ~400 tokens on every configuration tried —
 * scan batches of 8000, 1500 and 400 all reached the same point — which is per-token
 * retention rather than per-batch, and ~400 is just under the 500 this slice used to be.
 * The crash was therefore always inside the *first* slice, which is why changing the batch
 * size never helped. A DexScreener pair carries nested txn/volume/price history and the
 * lookup holds three copies of each (results array, per-chain index, merged map), so 500
 * tokens' worth exceeded the heap on its own. 50 keeps the peak around a tenth of that and
 * still batches efficiently, since the HTTP layer sends 30 addresses per request anyway.
 */
const MARKET_LOOKUP_SLICE_SIZE = 50;

/** A coin whose 24h-after-alert market cap is at or below this fraction of its entry
 * market cap is classified a 'dumper'. */
const DUMPER_MAX_FRACTION_OF_ENTRY = 0.5;

/** Unalerted coins whose observed ATH reaches this are flagged as missed winners —
 * comfortably above the $11k entry cap, so anything here genuinely ran without us. */
const MISSED_WINNER_MIN_ATH_USD = 25_000;

/**
 * Empirically-derived conviction rating for an alert, from the only two features measured
 * to actually separate winners from dumpers (2026-08-04, n=336 resolved alerts):
 *
 *   Robinhood, alerted <5 min after launch : 82% win /  9% dump  (n=44)
 *   Robinhood, any older bucket            : 31-42% win
 *   Solana,    under 30 min                : 19-26% win / 51-60% dump
 *   Solana,    30 min+                     : 40% win (small sample)
 *
 * Holder %, bundle %, dev-sold, socials and entry market cap were all tested and none
 * separated the groups — filtering on them removed winners and dumpers at the same rate.
 * This rating is shown on every alert and recorded with the outcome, so the buckets keep
 * being re-checked against fresh data rather than ossifying into folklore.
 */
export type AlertConviction = "high" | "medium" | "low";

/** A brand-new pair: the window where the measured win rate is 73-86%. */
const NEW_PAIR_MAX_AGE_MINUTES = 5;

/** Solana's early window is measured as dump-prone (51-60%), so a young Solana pair only
 * earns high conviction by proving itself on Jupiter's audit data instead of on age:
 * both authorities revoked and supply not concentrated in a handful of wallets. */
const SOLANA_NEW_PAIR_MAX_TOP_HOLDERS_PCT = 30;

export function rateConviction(
  chain: string,
  ageMinutesAtAlert: number | null,
  solanaSafety?: SolanaMintSafety | null,
  isBreakout = false
): AlertConviction {
  // A breakout is defined by a coin surging against its own baseline, so age is exactly
  // the wrong axis to judge it on — the age rule below would reject every one of them,
  // which is the whole gap this signal exists to close. Rated high so it clears the
  // owner's floor, and recorded under its own alert type so /insights measures whether
  // that rating is earned rather than leaving it as an assumption.
  if (isBreakout) return "high";
  if (ageMinutesAtAlert == null) return "medium";
  const isNewPair = ageMinutesAtAlert < NEW_PAIR_MAX_AGE_MINUTES;

  if (chain === "solana") {
    // Measured: Solana under 30 minutes wins 19-26% and dumps 51-60%. Age alone is not
    // enough here, but a new pair with revoked authorities and dispersed supply is a
    // materially different coin from the mass-minted rugs that produced those numbers.
    if (
      isNewPair &&
      solanaSafety &&
      !solanaSafety.mintAuthorityActive &&
      !solanaSafety.freezeAuthorityActive &&
      solanaSafety.topHoldersPct != null &&
      solanaSafety.topHoldersPct <= SOLANA_NEW_PAIR_MAX_TOP_HOLDERS_PCT
    ) {
      return "high";
    }
    return ageMinutesAtAlert < 30 ? "low" : "medium";
  }

  // Every EVM chain here launches through the same DEX factories with the same bundle
  // mechanics, so the new-pair window applies to all of them. Only Robinhood has a
  // measured win rate (86% for tier alerts under 5 minutes); BSC and Ethereum carry too
  // few resolved alerts to measure yet, and /insights breaks conviction out by outcome so
  // that assumption gets checked against real data rather than left to stand on its own.
  return isNewPair ? "high" : "medium";
}

const CONVICTION_RANK: Record<AlertConviction, number> = { low: 0, medium: 1, high: 2 };

/** True when an alert's conviction clears the owner's configured minimum. */
export function meetsMinConviction(conviction: AlertConviction, minimum: string): boolean {
  const floor = CONVICTION_RANK[minimum as AlertConviction] ?? 0;
  return CONVICTION_RANK[conviction] >= floor;
}

/** Records an entry-gate skip both in the log and on the token row, so the observer's
 * missed-winners audit can later show WHY a coin that did well was never alerted. */
function recordGateBlock(deps: PollerDeps, token: TokenRow, alertKind: string, reason: string): void {
  deps.logger.info({ address: token.address, symbol: token.symbol, blockReason: reason }, `Skipping ${alertKind} alert`);
  deps.tokenRepo.setLastBlockReason(token.address, reason, Date.now());
}

/**
 * How long a gate-blocked token waits before the fast path will spend another DexScreener
 * lookup re-evaluating it. Without this, a token that keeps failing the gate re-fetched its
 * snapshot on every 20s tick for hours; across thousands of daily launches that consumed
 * most of the request budget and starved the sweeps that find real movers.
 */
const GATE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Captures the entry features of a coin's first real alert into the observer's outcomes
 * table (INSERT OR IGNORE — later alerts never overwrite the original entry snapshot). */
function recordAlertOutcomeEntry(
  deps: PollerDeps,
  token: TokenRow,
  alertType: string,
  entryMarketCapUsd: number | null,
  snapshot: Pick<MarketSnapshot, "websiteUrl" | "socials"> | null | undefined,
  devStatus: DevStatus | null,
  holderConcentration: HolderConcentration | null,
  earlyBuyConcentration: EarlyBuyConcentration | null,
  now: number,
  solanaSafety?: SolanaMintSafety | null,
  isBreakout = false
): void {
  const ageMinutes = alertAgeMinutes(token, now);
  deps.outcomeRepo.recordEntry({
    address: token.address,
    firstAlertedAt: now,
    alertType,
    entryMarketCapUsd,
    bundleTop5Pct: earlyBuyConcentration?.top5Pct ?? null,
    holderTop10Pct: holderConcentration?.top10Pct ?? null,
    devSold: devStatus == null ? null : devStatus.sold ? 1 : 0,
    hadWebsite: Boolean(snapshot?.websiteUrl),
    socialCount: snapshot?.socials.length ?? 0,
    chain: token.chain,
    ageMinutesAtAlert: ageMinutes,
    conviction: rateConviction(token.chain, ageMinutes, solanaSafety, isBreakout),
  });
}

/** Minutes between the token's real launch and this alert. */
function alertAgeMinutes(token: TokenRow, now: number): number | null {
  if (!token.first_seen_at) return null;
  return Math.max(0, (now - token.first_seen_at) / 60000);
}

/** Blocks an alert whose measured conviction is below the owner's configured floor.
 * Default floor is "low", i.e. nothing is suppressed and coverage is unchanged. */
async function convictionBlockReason(
  deps: PollerDeps,
  token: TokenRow,
  now: number,
  isBreakout = false
): Promise<string | null> {
  const age = alertAgeMinutes(token, now);
  // Only a young Solana pair needs its audit data to be rated, so this costs one extra
  // lookup for exactly the coins whose rating depends on it.
  const safety =
    token.chain === "solana" && age != null && age < NEW_PAIR_MAX_AGE_MINUTES
      ? await deps.jupiterClient.fetchTokenSafety(token.address)
      : null;
  const conviction = rateConviction(token.chain, age, safety, isBreakout);
  if (meetsMinConviction(conviction, deps.minAlertConviction)) return null;
  return `${conviction} conviction, below the configured ${deps.minAlertConviction} floor`;
}

/**
 * Derives a coin's outcome from real observations only: 'winner' once its peak multiple
 * since alert reaches 2x (peak never decreases, so winner is permanent), 'dumper' once
 * the 24h checkpoint shows it at or below half its entry market cap, 'flat' once 24h has
 * been observed without either, else 'pending'.
 */
function classifyOutcome(
  row: AlertOutcomeRow,
  peakMultiple: number,
  mcap24hUsd: number | null | undefined
): string {
  if (row.outcome === "winner" || peakMultiple >= WINNER_MIN_PEAK_MULTIPLE) return "winner";
  const mcap24 = mcap24hUsd !== undefined ? mcap24hUsd : row.mcap_24h_usd;
  if (mcap24 != null && row.entry_market_cap_usd != null && row.entry_market_cap_usd > 0) {
    return mcap24 <= row.entry_market_cap_usd * DUMPER_MAX_FRACTION_OF_ENTRY ? "dumper" : "flat";
  }
  return "pending";
}

/**
 * The observer: (1) revisits every alerted coin at ~1h/6h/24h after its alert, records
 * the market cap it found (0 = no pair returned anymore, i.e. liquidity pulled), and
 * classifies the coin winner/dumper/flat; (2) audits the whole token table for coins
 * that reached a high ATH without ever being alerted, recording them with the gate
 * reason that blocked them. Everything it stores is a real observation — the /insights
 * command turns this into winners-vs-dumpers pattern comparisons and recommendations.
 */
export async function runObserverSweep(deps: PollerDeps, now: number): Promise<void> {
  const { outcomeRepo, tokenRepo, dex, dexScreenerChainId, logger } = deps;

  const due = outcomeRepo.listDueForCheckpoints(now);
  if (due.length > 0) {
    // Outcome rows carry no chain of their own — resolve each one's token row so the
    // lookup hits the right chain for coins tracked off Robinhood.
    const dueTokens = due
      .map((r) => tokenRepo.findByAddress(r.address))
      .filter((t): t is NonNullable<typeof t> => t != null);
    {
      const pairsByToken = await lookupPairsAcrossChains(deps, dueTokens);
      const h1 = 60 * 60 * 1000;
      for (const row of due) {
        const pair = pickCanonicalPair(pairsByToken, row.address);
        // 0 = DexScreener returned no pair at all (liquidity pulled / delisted) — a real
        // observation. A pair with an unknown mcap leaves the checkpoint NULL to retry.
        const mcap = pair ? toMarketSnapshot(pair, row.address).marketCapUsd : 0;
        const elapsed = now - row.first_alerted_at;
        const checkpoints: { mcap1hUsd?: number; mcap6hUsd?: number; mcap24hUsd?: number } = {};
        if (row.mcap_1h_usd == null && elapsed >= h1 && mcap != null) checkpoints.mcap1hUsd = mcap;
        if (row.mcap_6h_usd == null && elapsed >= 6 * h1 && mcap != null) checkpoints.mcap6hUsd = mcap;
        if (row.mcap_24h_usd == null && elapsed >= 24 * h1 && mcap != null) checkpoints.mcap24hUsd = mcap;

        const token = tokenRepo.findByAddress(row.address);
        const outcome = classifyOutcome(row, token?.peak_multiple ?? 0, checkpoints.mcap24hUsd);
        outcomeRepo.applyCheckpoints(row.address, checkpoints, outcome, now);

        // One-time dump/rug warning: the pair vanished entirely (mcap 0) or the coin
        // crashed below the warning floor vs its entry — tell the owner immediately
        // instead of letting them find out from the 24h outcome stats.
        if (
          token &&
          !row.warning_sent &&
          mcap != null &&
          row.entry_market_cap_usd != null &&
          row.entry_market_cap_usd > 0 &&
          (mcap === 0 || mcap <= row.entry_market_cap_usd * DUMP_WARNING_MAX_FRACTION_OF_ENTRY)
        ) {
          outcomeRepo.markWarningSent(row.address);
          const html = buildDumpWarningAlertHtml(token, row.entry_market_cap_usd, mcap);
          if (deps.dryRunAlerts) {
            logger.info({ address: row.address, symbol: token.symbol, html }, "[DRY RUN] Would send dump warning");
          } else {
            try {
              await deps.notifier.sendAlert(deps.telegramChatId, html, {
                imageUrls: await buildAlertImageCandidates(deps, token),
              });
              logger.info({ address: row.address, symbol: token.symbol, mcap }, "Sent dump warning");
            } catch (err) {
              logger.error({ address: row.address, err: String(err) }, "Failed to send dump warning");
            }
          }
        }
      }
      logger.info({ checked: due.length }, "Observer checkpoint sweep complete");
    }
  }

  const missed = tokenRepo.listUnalertedHighAth(MISSED_WINNER_MIN_ATH_USD);
  for (const t of missed) {
    outcomeRepo.upsertMissedWinner(t.address, t.symbol, now, t.ath_market_cap_usd ?? 0, t.last_block_reason);
  }
  if (missed.length > 0) {
    logger.info({ missedWinners: missed.length }, "Observer missed-winners audit complete");
  }

  await autoTuneBundleCap(deps, now);
}

/** Minimum winner AND dumper sample counts before the auto-tuner may act. */
const AUTO_TUNE_MIN_SAMPLES = 5;

/** Minimum winners-vs-dumpers average-bundle gap (percentage points) that counts as a
 * real pattern rather than noise. */
const AUTO_TUNE_MIN_GAP_PCT = 10;

/** Minimum change (percentage points) worth applying, to avoid churn. */
const AUTO_TUNE_MIN_CHANGE_PCT = 2;

/** A coin at or below this fraction of its entry market cap triggers the dump warning. */
const DUMP_WARNING_MAX_FRACTION_OF_ENTRY = 0.2;

/**
 * The observer's "reapply fixes" step: when real outcomes show dumpers carrying
 * meaningfully heavier bundles than winners (both groups sampled adequately), the
 * effective bundle cap is tightened to the midpoint of the two averages — clamped to
 * [MIN_BUNDLE_CAP_PCT, MAX_BUNDLE_CAP_PCT] and only ever tightening, never loosening
 * past the owner's 60% hard ceiling. Every applied change is announced to the owner in
 * Telegram with the exact data that justified it.
 */
async function autoTuneBundleCap(deps: PollerDeps, now: number): Promise<void> {
  const { outcomeRepo, settingsRepo, notifier, telegramChatId, dryRunAlerts, logger } = deps;

  const stats = new Map(outcomeRepo.featureStatsByOutcome().map((s) => [s.outcome, s]));
  const winner = stats.get("winner");
  const dumper = stats.get("dumper");
  if (!winner || !dumper || winner.count < AUTO_TUNE_MIN_SAMPLES || dumper.count < AUTO_TUNE_MIN_SAMPLES) return;
  if (winner.avgBundleTop5Pct == null || dumper.avgBundleTop5Pct == null) return;
  if (dumper.avgBundleTop5Pct - winner.avgBundleTop5Pct < AUTO_TUNE_MIN_GAP_PCT) return;

  const current = effectiveBundleCapPct(settingsRepo);
  const midpoint = (winner.avgBundleTop5Pct + dumper.avgBundleTop5Pct) / 2;
  const proposed = Math.round(Math.min(MAX_BUNDLE_CAP_PCT, Math.max(MIN_BUNDLE_CAP_PCT, midpoint)));
  if (proposed >= current || current - proposed < AUTO_TUNE_MIN_CHANGE_PCT) return;

  // Replay the proposed cap against real history before applying it. A gap between group
  // *averages* is not evidence a threshold separates them — the distributions can overlap
  // so heavily that the cut removes more winners than dumpers. (Measured 2026-08-04: a
  // holder-concentration cap looked justified on averages, yet blocked 15 winners to avoid
  // 7 dumpers at every threshold tested.) Only tighten when the cut is genuinely favourable.
  const history = outcomeRepo.resolvedBundleOutcomes();
  const blocked = history.filter((row) => row.bundlePct > proposed);
  const winnersBlocked = blocked.filter((row) => row.outcome === "winner").length;
  const dumpersBlocked = blocked.filter((row) => row.outcome === "dumper").length;
  if (dumpersBlocked <= winnersBlocked) {
    logger.info(
      { proposedCapPct: proposed, winnersBlocked, dumpersBlocked },
      "Skipping bundle-cap auto-tune: the proposed cap would not remove more dumpers than winners"
    );
    return;
  }

  settingsRepo.set(BUNDLE_CAP_SETTING_KEY, String(proposed), now);
  logger.info(
    { previousCapPct: current, newCapPct: proposed, winners: winner.count, dumpers: dumper.count },
    "Observer auto-tuned the bundle cap"
  );

  const html =
    `🔧 <b>AUTO-TUNE APPLIED</b>\n\n` +
    `Bundle cap tightened <b>${current}% → ${proposed}%</b>.\n\n` +
    `Based on real outcomes: ${winner.count} winners averaged ${winner.avgBundleTop5Pct.toFixed(0)}% bundle, ` +
    `${dumper.count} dumpers averaged ${dumper.avgBundleTop5Pct.toFixed(0)}%.\n` +
    `Replayed against history, this cap removes ${dumpersBlocked} dumpers vs ${winnersBlocked} winners.\n\n` +
    `The observer only ever tightens this cap (floor ${MIN_BUNDLE_CAP_PCT}%, ceiling ${MAX_BUNDLE_CAP_PCT}%). Current value always visible in /insights.`;
  if (!dryRunAlerts) {
    try {
      await notifier.sendAlert(telegramChatId, html);
    } catch (err) {
      logger.error({ err: String(err) }, "Failed to send auto-tune notification");
    }
  }
}

export interface PollerDeps {
  chainClient: ChainClient;
  discoveryStateRepo: DiscoveryStateRepo;
  tokenRepo: TokenRepo;
  snapshotRepo: SnapshotRepo;
  alertRepo: AlertRepo;
  dex: DexScreenerClient;
  notifier: Notifier;
  logger: Logger;
  classifierConfig: ClassifierConfig;
  factories: FactoryConfig[];
  dexScreenerChainId: string;
  discoveryChunkBlocks: number;
  discoveryMaxLaunchesPerCycle: number;
  discoveryMinLiquidityUsd: number;
  spamDeployerThreshold: number;
  unindexedRecheckHours: number;
  graduationCheckBatchSize: number;
  snapshotRetentionDays: number;
  telegramChatId: string;
  dryRunAlerts: boolean;
  ethPriceClient: EthPriceClient;
  ungraduatedFastWindowHours: number;
  marketCapAlertTiersUsd: number[];
  earlyMomentumMaxAgeMinutes: number;
  earlyMomentumMinBuys5m: number;
  earlyMomentumMinVolume5mUsd: number;
  momentumRealertMultiple: number;
  performanceMilestoneMultiples: number[];
  earlyBuyWindowBlocks: number;
  outcomeRepo: OutcomeRepo;
  settingsRepo: SettingsRepo;
  marketScanBatchSize: number;
  /** Consecutive empty market lookups before an 'active' token is demoted to 'unindexed'. */
  noMarketDataDemoteStreak: number;
  /** Liquidity must be at least this percent of market cap for the figure to be believed. */
  minLiquidityToMcapPct: number;
  /** DexScreener chainId slugs this bot tracks (see src/data/chains.ts). */
  enabledChains: string[];
  /** Watch DEX pool factories directly, catching tokens launched outside Pons. */
  dexPoolDiscoveryEnabled: boolean;
  /** Restrict scanning and alerting to the two Pons launchpad factories. */
  ponsLaunchpadOnly: boolean;
  /** Per-chain pool-factory scanning setup (Robinhood, plus BSC/Ethereum when configured). */
  poolChainConfigs: ChainPoolConfig[];
  /** Blockscout-compatible holder/metadata APIs, keyed by chain. Robinhood and Ethereum
   * have free keyless instances; chains absent here simply omit holder data. */
  blockscoutByChain: Record<string, BlockscoutClient>;
  /** Solana JSON-RPC client, used for SPL mint/freeze authority safety checks. */
  solanaClient: SolanaClient;
  /** Jupiter token API, the free source that surfaces Solana tokens at birth. */
  jupiterClient: JupiterClient;
  /** Optional X search; unconfigured means alerts omit the mentions line. */
  xSearchClient?: XSearchClient;
  /** A Solana deployer with more lifetime mints than this is treated as a spam farm. */
  solanaSpamDevMints: number;
  /** Lowest conviction rating allowed through ("low" = everything, preserving coverage). */
  minAlertConviction: string;
  /** Breakout signal thresholds — a coin surging against its own baseline, at any age. */
  breakoutVolumeMultiple: number;
  breakoutMinVolume1hUsd: number;
  breakoutMinBuys1h: number;
  breakoutCooldownHours: number;
  /** How far price must recover off the sampled floor to count as a reversal. */
  reversalMultiple: number;
}

/**
 * Shared by both the fast (pre-graduation, on-chain) and slow (post-graduation,
 * DexScreener) paths: checks a real, sourced market cap against the configured tier
 * ladder and fires at most one combined alert per newly-crossed set of tiers, updating
 * `graduation_alert_tier` so already-crossed tiers never re-fire. This is what lets
 * market-cap tier alerts span pre- and post-graduation seamlessly (section 1c of the
 * plan) — the caller just supplies whichever market cap source it has on hand.
 */
async function checkAndSendMarketCapTierAlert(
  deps: PollerDeps,
  token: TokenRow,
  marketCapUsd: number,
  pairedWei: string,
  thresholdWei: string,
  now: number,
  snapshot?: MarketSnapshot | null
): Promise<void> {
  const { tokenRepo, notifier, telegramChatId, dryRunAlerts, marketCapAlertTiersUsd, dexScreenerChainId, logger } = deps;
  if (marketCapAlertTiersUsd.length === 0) return;

  const crossedTiers: number[] = [];
  let newTierIndex = token.graduation_alert_tier;
  for (let i = token.graduation_alert_tier; i < marketCapAlertTiersUsd.length; i++) {
    const tierUsd = marketCapAlertTiersUsd[i]!;
    if (marketCapUsd < tierUsd) break;
    crossedTiers.push(tierUsd);
    newTierIndex = i + 1;
  }
  if (crossedTiers.length === 0) return;

  // Fast-path callers work purely on-chain and pass no snapshot — fetch one now so the
  // entry gate has links/sell data and the alert itself gets links + an image. Throttled:
  // a token blocked moments ago is very unlikely to have changed, and re-fetching it every
  // tick is what exhausted the request budget.
  if (snapshot === undefined || snapshot === null) {
    if (token.last_block_at != null && now - token.last_block_at < GATE_RECHECK_INTERVAL_MS) return;
    snapshot = await fetchSnapshotForToken(deps, token);
  }
  const blockReason = entryAlertBlockReason(marketCapUsd, snapshot, alertAgeMinutes(token, now)) ?? (await convictionBlockReason(deps, token, now));
  if (blockReason) {
    // Transient conditions (market cap not resolved yet, links not indexed yet, a
    // zero-sell hour) — deliberately do NOT consume the tier index or capture an entry
    // baseline, so this coin can still get the alert on a later cycle once it qualifies.
    recordGateBlock(deps, token, "market-cap tier", blockReason);
    return;
  }

  const devStatus = await resolveDevStatus(deps, token);
  const holderConcentration = await resolveHolderConcentration(deps, token);
  const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
  if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
    // Bundle % is fixed at launch, so this block is permanent — consume the tier index
    // to stop re-running these on-chain lookups for the same coin every cycle.
    tokenRepo.setGraduationAlertTier(token.address, newTierIndex);
    recordGateBlock(deps, token, "market-cap tier", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
    return;
  }
  const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
  if (safetyBlock) {
    recordGateBlock(deps, token, "market-cap tier", safetyBlock);
    return;
  }

  tokenRepo.setGraduationAlertTier(token.address, newTierIndex);
  maybeCaptureFirstAlertBaseline(deps, token, marketCapUsd, now);
  // Tier crossings are the most common alert, so they carry the X-mentions line too —
  // resolved only here, at send time, never during the scan.
  const tierXMentions = await resolveXMentions(deps, token);
  const html = buildMarketCapAlertHtml(
    token,
    crossedTiers,
    marketCapUsd,
    pairedWei,
    thresholdWei,
    token.chain,
    snapshot,
    devStatus,
    holderConcentration,
    earlyBuyConcentration,
    solanaSafety,
    rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety),
    tierXMentions
  );
  if (dryRunAlerts) {
    logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send market-cap tier alert");
    return;
  }
  const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${token.pair_address}`;
  try {
    await notifier.sendAlert(telegramChatId, html, {
      dexScreenerUrl,
      imageUrls: await buildAlertImageCandidates(deps, token, snapshot?.imageUrl),
    });
    recordAlertOutcomeEntry(deps, token, "market-cap-tier", marketCapUsd, snapshot, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety);
    logger.info({ address: token.address, symbol: token.symbol, crossedTiers }, "Sent market-cap tier alert");
  } catch (err) {
    logger.error({ address: token.address, err: String(err) }, "Failed to send market-cap tier alert");
  }
}

/** True if a token shows any sign of having been alerted before (any of the 4 alert
 * types), used to opportunistically backfill an entry baseline for tokens alerted
 * before the performance-tracking feature existed. */
function hasPriorAlertSignal(token: TokenRow): boolean {
  return token.last_alert_at != null || token.graduation_alert_tier > 0 || token.momentum_alert_count > 0;
}

/**
 * Resolves the deployer wallet's real sold/held status via a single on-chain
 * `balanceOf` read, called only right before an alert is about to fire (not every poll
 * cycle for every token). Returns null — meaning the caller omits the dev-status line
 * entirely — when there's no deployer address on record or the read fails; never
 * fabricates a status or percentage.
 */
/**
 * Looks up which X accounts posted this coin's contract address.
 *
 * Runs only at the point an alert is actually being sent — never during the scan — so the
 * cost is a handful of calls a day rather than one per coin per cycle. Returns null when
 * the search is unconfigured or failed, which the alert renders as "no line" rather than
 * "nobody is talking about this".
 */
async function resolveXMentions(deps: PollerDeps, token: TokenRow): Promise<XMention[] | null> {
  const client = deps.xSearchClient;
  if (!client || !client.configured) return null;
  return client.findMentions(token.address);
}

async function resolveDevStatus(deps: PollerDeps, token: TokenRow): Promise<DevStatus | null> {
  // Reads the Robinhood RPC — meaningless for a token on another chain.
  if (!hasOnChainIntegrations(token.chain)) return null;
  if (!token.deployer_address) return null;
  const balance = await readTokenBalance(deps.chainClient, token.address, token.deployer_address);
  if (balance == null) return null;
  if (balance === 0n) return { sold: true, holdingPct: null };
  if (token.token_total_supply && token.token_decimals != null) {
    const totalSupply = BigInt(token.token_total_supply);
    if (totalSupply > 0n) {
      return { sold: false, holdingPct: (Number(balance) / Number(totalSupply)) * 100 };
    }
  }
  return { sold: false, holdingPct: null };
}

/**
 * Resolves real, on-chain holder-concentration data for a token via Blockscout's holders
 * API, called only right before an alert is about to fire (not every poll cycle for every
 * token). Returns null — meaning the caller omits the concentration line entirely — when
 * total supply isn't cached yet or the Blockscout read fails; never fabricates a
 * percentage. Excludes the token's own liquidity pool and the token contract itself from
 * the ranking, since neither represents a real investor holding.
 */
async function resolveHolderConcentration(deps: PollerDeps, token: TokenRow): Promise<HolderConcentration | null> {
  // Needs a Blockscout-compatible holders API for the token's chain. Robinhood and
  // Ethereum have free keyless instances; other chains have none, so the line is omitted.
  const blockscout = deps.blockscoutByChain[token.chain];
  if (!blockscout) return null;

  // Total supply turns raw balances into percentages. Prefer the cached value; otherwise
  // read it from the chain's own RPC where we have one (Robinhood), else from Blockscout's
  // token metadata. Cached afterwards so this costs one lookup per token, ever.
  let totalSupplyStr = token.token_total_supply;
  if (!totalSupplyStr) {
    const supply = hasOnChainIntegrations(token.chain)
      ? await readTotalSupply(deps.chainClient, token.address)
      : ((await blockscout.fetchTokenMeta(token.address))?.totalSupply ?? null);
    if (supply == null || supply <= 0n) return null;
    totalSupplyStr = supply.toString();
    deps.tokenRepo.setTokenTotalSupplyIfMissing(token.address, totalSupplyStr);
  }

  const holders = await blockscout.fetchHolders(token.address);
  if (!holders) return null;
  // The trading pair itself holds a large balance on every chain and is not an investor —
  // excluded alongside the token contract and (on Robinhood) its V3 pool.
  return computeHolderConcentration(
    holders,
    [token.pool_address, token.pair_address, token.address],
    BigInt(totalSupplyStr)
  );
}

/**
 * Chain-specific safety signals resolved just before an alert fires, plus a block reason
 * when one of them disqualifies the coin outright.
 *
 * Solana: an active freeze authority lets whoever holds it freeze holder accounts, making
 * the token unsellable — the Solana honeypot, so it blocks. An active mint authority is
 * surfaced to the owner but doesn't block on its own.
 */
async function resolveChainSafety(
  deps: PollerDeps,
  token: TokenRow
): Promise<{ solana: SolanaMintSafety | null; blockReason: string | null }> {
  if (token.chain !== "solana") return { solana: null, blockReason: null };
  // Jupiter first: it carries holder concentration and holder count alongside the
  // authority flags, and isn't rate-limited the way the public RPC's equivalent call is.
  // The direct RPC read stays as a fallback so a Jupiter outage doesn't blind the gate.
  const solana =
    (await deps.jupiterClient.fetchTokenSafety(token.address)) ?? (await deps.solanaClient.fetchMintSafety(token.address));
  // Jupiter is often the only place a brand-new Solana token has an icon. Cache it and
  // patch the in-memory row, since the image chain for this very alert is built afterwards.
  if (solana?.iconUrl && !token.image_url) {
    deps.tokenRepo.setImageUrlIfMissing(token.address, solana.iconUrl);
    token.image_url = solana.iconUrl;
  }
  if (solana?.freezeAuthorityActive) {
    return { solana, blockReason: "freeze authority still active — holders could be blocked from selling" };
  }
  return { solana: solana ?? null, blockReason: null };
}

/**
 * Resolves real early-buyer concentration ("bundle %") via a single bounded getLogs read
 * of Transfer events from the token's own pool in the first `earlyBuyWindowBlocks` blocks
 * after launch, called only right before an alert is about to fire. Returns null — meaning
 * the caller omits the line entirely — when there's no recorded launch block/pool address
 * (legacy tokens), total supply can't be resolved, or the read fails; never fabricates a
 * percentage.
 */
async function resolveEarlyBuyConcentration(deps: PollerDeps, token: TokenRow): Promise<EarlyBuyConcentration | null> {
  // Needs Pons launch-event data (launch block + pool) and the Robinhood RPC.
  if (!hasOnChainIntegrations(token.chain)) return null;
  if (!token.launch_block || !token.pool_address) return null;
  let totalSupply: bigint | null = token.token_total_supply ? BigInt(token.token_total_supply) : null;
  if (totalSupply == null) {
    totalSupply = await readTotalSupply(deps.chainClient, token.address);
    if (totalSupply == null) return null;
  }
  const result = await readEarlyBuyConcentration(
    deps.chainClient,
    token.address,
    BigInt(token.launch_block),
    deps.earlyBuyWindowBlocks,
    token.pool_address,
    totalSupply,
    deps.logger
  );
  if (!result) return null;
  return { ...result, windowBlocks: deps.earlyBuyWindowBlocks };
}

/**
 * Captures the entry market-cap baseline for post-alert performance tracking, if this
 * token doesn't already have one — also guarded at the DB layer (setFirstAlertMarketCap
 * only writes WHERE first_alert_market_cap_usd IS NULL), so this is safe to call both at
 * genuine first-alert time and opportunistically in the sweeps below as a one-time
 * backfill for tokens alerted before this feature existed (using today's market cap,
 * since their true historical alert-time value was never recorded).
 */
function maybeCaptureFirstAlertBaseline(deps: PollerDeps, token: TokenRow, marketCapUsd: number | null, now: number): void {
  if (marketCapUsd == null || token.first_alert_market_cap_usd != null) return;
  deps.tokenRepo.setFirstAlertMarketCap(token.address, marketCapUsd, now);
}

/**
 * Updates the peak multiple-since-first-alert for a token that already has an entry
 * baseline, and checks the result against the configured milestone ladder
 * (performanceMilestoneMultiples), firing at most one combined alert per newly-crossed
 * set of milestones, permanently guarded by last_milestone_multiple_alerted so an
 * already-crossed milestone never re-fires. Mirrors checkAndSendMarketCapTierAlert. No-op
 * if the token has no baseline yet (baseline capture/backfill happens separately).
 */
async function trackPeakMultipleAndAlert(
  deps: PollerDeps,
  token: TokenRow,
  marketCapUsd: number | null,
  now: number,
  snapshot?: MarketSnapshot | null
): Promise<void> {
  const baseline = token.first_alert_market_cap_usd;
  if (marketCapUsd == null || baseline == null || baseline <= 0) return;

  // Milestone alerts are deliberately exempt from the market-cap entry cap, which means
  // nothing else stops a phantom price here: a drained pool reporting a $66B market cap
  // computes as a six-million-x gain and fires every milestone on the ladder. Whenever a
  // real liquidity reading is on hand, it has to actually back the figure.
  if (snapshot && !isMarketCapTrustworthy(marketCapUsd, snapshot.liquidityUsd, deps.minLiquidityToMcapPct)) {
    deps.logger.info(
      { address: token.address, symbol: token.symbol, marketCapUsd, liquidityUsd: snapshot.liquidityUsd },
      "Skipping performance milestone: market cap not backed by liquidity"
    );
    return;
  }

  const multiple = marketCapUsd / baseline;
  deps.tokenRepo.updatePeakMultiple(token.address, multiple, now);

  const { performanceMilestoneMultiples, tokenRepo, notifier, telegramChatId, dryRunAlerts, dexScreenerChainId, logger } = deps;
  if (performanceMilestoneMultiples.length === 0) return;

  const crossed: number[] = [];
  for (const m of performanceMilestoneMultiples) {
    if (m <= token.last_milestone_multiple_alerted) continue;
    if (multiple < m) break;
    crossed.push(m);
  }
  if (crossed.length === 0) return;

  tokenRepo.setLastMilestoneMultipleAlerted(token.address, crossed[crossed.length - 1]!);
  // Fast-path callers pass no snapshot — fetch one now (only on an actual milestone
  // crossing, never per tick) so the alert gets links and an image.
  if (snapshot === undefined || snapshot === null) {
    snapshot = await fetchSnapshotForToken(deps, token);
  }
  const devStatus = await resolveDevStatus(deps, token);
  const holderConcentration = await resolveHolderConcentration(deps, token);
  const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
  // Milestone alerts are deliberately gate-exempt (they track a position taken after a
  // gated entry), so the safety signals are shown but never used to block here.
  const { solana: solanaSafety } = await resolveChainSafety(deps, token);
  const html = buildPerformanceMilestoneAlertHtml(
    token,
    crossed,
    marketCapUsd,
    token.chain,
    token.pair_address,
    snapshot,
    devStatus,
    holderConcentration,
    earlyBuyConcentration,
    solanaSafety,
    rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety)
  );
  if (dryRunAlerts) {
    logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send performance milestone alert");
    return;
  }
  const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${token.pair_address}`;
  try {
    await notifier.sendAlert(telegramChatId, html, {
      dexScreenerUrl,
      imageUrls: await buildAlertImageCandidates(deps, token, snapshot?.imageUrl),
    });
    logger.info({ address: token.address, symbol: token.symbol, crossed }, "Sent performance milestone alert");
  } catch (err) {
    logger.error({ address: token.address, err: String(err) }, "Failed to send performance milestone alert");
  }
}

function handleActiveToken(deps: PollerDeps, token: TokenRow, ageHrs: number, current: ReturnType<typeof toMarketSnapshot>, now: number): void {
  const { tokenRepo, classifierConfig } = deps;
  const dead = meetsDeadCriteria(
    classifierConfig,
    ageHrs,
    { volume24h: current.volume24h, volume1h: current.volume1h, buys1h: current.buys1h, liquidityUsd: current.liquidityUsd }
  );
  if (dead) {
    const next = token.dead_confirm_count + 1;
    if (next >= classifierConfig.deadConfirmPolls) {
      tokenRepo.updateStatus(token.address, "dead", now);
      deps.logger.info({ address: token.address, symbol: token.symbol }, "Token classified as dead");
    } else {
      tokenRepo.setDeadConfirmCount(token.address, next);
    }
  } else if (token.dead_confirm_count !== 0) {
    tokenRepo.setDeadConfirmCount(token.address, 0);
  }
}

async function handleDeadToken(deps: PollerDeps, token: TokenRow, current: ReturnType<typeof toMarketSnapshot>, now: number): Promise<void> {
  const { tokenRepo, snapshotRepo, alertRepo, classifierConfig, notifier, telegramChatId, dryRunAlerts, dexScreenerChainId, logger } = deps;

  const history = snapshotRepo.recentSince(token.address, token.status_changed_at, BASELINE_SAMPLE_LIMIT);
  if (history.length === 0) {
    // No prior snapshots yet since becoming dead; nothing to compare against this cycle.
    return;
  }
  const baseline = computeBaseline(history);

  const revived = meetsRevivalCriteria(
    classifierConfig,
    { volume24h: current.volume24h, volume1h: current.volume1h, buys1h: current.buys1h, liquidityUsd: current.liquidityUsd },
    baseline
  );

  if (!revived) {
    if (token.revival_confirm_count !== 0) {
      tokenRepo.setRevivalConfirmCount(token.address, 0);
    }
    return;
  }

  const next = token.revival_confirm_count + 1;
  if (next < classifierConfig.revivalConfirmPolls) {
    tokenRepo.setRevivalConfirmCount(token.address, next);
    return;
  }

  if (isInCooldown(token.last_alert_at, now, classifierConfig.alertCooldownHours)) {
    logger.info({ address: token.address, symbol: token.symbol }, "Revival confirmed but alert is in cooldown, skipping");
    tokenRepo.setRevivalConfirmCount(token.address, next);
    return;
  }

  // Entry gate: revival is confirmed, but only alert on coins the owner would actually
  // enter — known sub-$11k market cap, credible provenance, no honeypot/bundle signals.
  // The confirm count is kept so the token stays alert-ready, but deliberately NO cooldown
  // stamp: `last_alert_at` also drives isInCooldown, so stamping it on every blocked cycle
  // held the token in a rolling 6h cooldown that outlived the block itself and silently
  // suppressed the alert long after the coin qualified again.
  const gateReason = entryAlertBlockReason(resolveMarketCapUsd(current), current, alertAgeMinutes(token, now)) ?? (await convictionBlockReason(deps, token, now));
  if (gateReason) {
    recordGateBlock(deps, token, "revival", gateReason);
    tokenRepo.setRevivalConfirmCount(token.address, next);
    return;
  }

  const deadForHours = ageHours(now, token.status_changed_at);
  const devStatus = await resolveDevStatus(deps, token);
  const holderConcentration = await resolveHolderConcentration(deps, token);
  const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
  if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
    recordGateBlock(deps, token, "revival", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
    tokenRepo.setRevivalConfirmCount(token.address, next);
    return;
  }
  const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
  if (safetyBlock) {
    recordGateBlock(deps, token, "revival", safetyBlock);
    tokenRepo.setRevivalConfirmCount(token.address, next);
    tokenRepo.setLastAlertAt(token.address, now);
    return;
  }
  const revivalXMentions = await resolveXMentions(deps, token);
  const html = buildRevivalAlertHtml(
    token,
    current,
    baseline,
    deadForHours,
    token.chain,
    undefined,
    devStatus,
    holderConcentration,
    earlyBuyConcentration,
    solanaSafety,
    rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety),
    revivalXMentions
  );

  maybeCaptureFirstAlertBaseline(deps, token, resolveMarketCapUsd(current), now);

  if (dryRunAlerts) {
    logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send revival alert");
  } else {
    const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${current.pairAddress}`;
    await notifier.sendAlert(telegramChatId, html, {
      dexScreenerUrl,
      imageUrls: await buildAlertImageCandidates(deps, token, current.imageUrl),
    });
    recordAlertOutcomeEntry(deps, token, "revival", resolveMarketCapUsd(current), current, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety);
    logger.info({ address: token.address, symbol: token.symbol }, "Sent revival alert");
  }

  alertRepo.insert({
    address: token.address,
    ts: now,
    dryRun: dryRunAlerts,
    volume1h: current.volume1h,
    buys1h: current.buys1h,
    liquidityUsd: current.liquidityUsd,
    priceUsd: current.priceUsd,
    baselineMedianVolume1h: baseline.medianVolume1h,
    baselineMedianLiquidityUsd: baseline.medianLiquidityUsd,
    deadForHours,
  });

  tokenRepo.markAlerted(token.address, now);
}

/**
 * Detects a coin breaking out — accelerating hard against its own trailing baseline —
 * regardless of how old it is.
 *
 * Every other entry path is anchored to launch: momentum requires a coin under 60 minutes,
 * and the high-conviction window is 5. So a coin that sits quiet for hours or days and then
 * makes its 2k→high move had no path to an alert at all; it simply reappeared later, already
 * past the $11k entry cap. This closes that hole.
 *
 * Scoped to 'active' tokens: a dead coin waking up is a revival and is already handled by
 * `handleDeadToken`, and duplicating it here would double-alert the same event. The baseline
 * read only happens for coins whose live numbers already look like a surge, so the DB cost
 * is paid for candidates rather than for every token in the cycle.
 */
async function handleBreakoutCandidate(
  deps: PollerDeps,
  token: TokenRow,
  current: ReturnType<typeof toMarketSnapshot>,
  now: number
): Promise<void> {
  const { tokenRepo, snapshotRepo, notifier, telegramChatId, dryRunAlerts, logger } = deps;
  // A coin resting on its floor is classified 'dead', not 'active' — which is exactly the
  // coin worth catching as it turns back up. Restricting this handler to 'active' meant the
  // reversal signal could never see its own target. Dead coins are evaluated for reversal
  // only: a *volume* surge on a dead coin is already the revival signal's job.
  const isDeadCandidate = token.status === "dead";
  if (token.status !== "active" && !isDeadCandidate) return;
  if (isInCooldown(token.breakout_alerted_at, now, deps.breakoutCooldownHours)) return;
  // Respect the shared alert cooldown too, so a coin that just fired a revival alert does
  // not immediately fire a near-identical reversal alert on the same move.
  if (isInCooldown(token.last_alert_at, now, deps.classifierConfig.alertCooldownHours)) return;

  // Cheap pre-filter on the live numbers before touching snapshot history.
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;
  // Screened at the *reversal* floors, which are half the breakout ones. Screening at the
  // full breakout floors here discarded every reversal candidate before it was ever tested,
  // silently making the lower reversal thresholds dead code.
  if (volume1h < deps.breakoutMinVolume1hUsd / 2 || buys1h < Math.max(3, Math.floor(deps.breakoutMinBuys1h / 2))) {
    return;
  }

  const history = snapshotRepo.recentSince(token.address, 0, BASELINE_SAMPLE_LIMIT);
  if (history.length === 0) return;
  const baseline = computeBaseline(history);

  const breakoutConfig = {
    breakoutVolumeMultiple: deps.breakoutVolumeMultiple,
    breakoutMinVolume1hUsd: deps.breakoutMinVolume1hUsd,
    breakoutMinBuys1h: deps.breakoutMinBuys1h,
  };
  // Either shape of "people are suddenly bidding this" qualifies: a volume breakout, or a
  // price reversal off the floor. The second exists because the first structurally cannot
  // see a coin turning up from its low on ordinary volume, which was the bulk of what this
  // bot was missing.
  const metrics = { volume24h: current.volume24h, volume1h, buys1h, liquidityUsd: current.liquidityUsd };
  const isBreakoutSurge = !isDeadCandidate && meetsBreakoutCriteria(breakoutConfig, metrics, baseline);
  const isReversal =
    !isBreakoutSurge &&
    meetsReversalCriteria(
      { ...breakoutConfig, reversalMultiple: deps.reversalMultiple },
      { ...metrics, priceUsd: current.priceUsd },
      baseline
    );
  if (!isBreakoutSurge && !isReversal) {
    return;
  }

  const gateReason =
    untrustworthyMarketCapReason(deps, resolveMarketCapUsd(current), current.liquidityUsd) ??
    entryAlertBlockReason(
      resolveMarketCapUsd(current),
      current,
      alertAgeMinutes(token, now)
    ) ??
    (await convictionBlockReason(deps, token, now, true));
  if (gateReason) {
    recordGateBlock(deps, token, "breakout", gateReason);
    return;
  }

  const devStatus = await resolveDevStatus(deps, token);
  const holderConcentration = await resolveHolderConcentration(deps, token);
  const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
  if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
    recordGateBlock(deps, token, "breakout", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
    return;
  }
  const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
  if (safetyBlock) {
    recordGateBlock(deps, token, "breakout", safetyBlock);
    return;
  }

  // Stamped before sending so a send failure can't cause a retry storm on the next cycle.
  tokenRepo.setBreakoutAlertedAt(token.address, now);
  maybeCaptureFirstAlertBaseline(deps, token, resolveMarketCapUsd(current), now);

  const xMentions = await resolveXMentions(deps, token);
  const html = buildBreakoutAlertHtml(
    token,
    current,
    baseline,
    ageHours(now, token.first_seen_at),
    token.chain,
    devStatus,
    holderConcentration,
    earlyBuyConcentration,
    solanaSafety,
    xMentions
  );
  if (dryRunAlerts) {
    logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send breakout alert");
    return;
  }
  try {
    await notifier.sendAlert(telegramChatId, html, {
      dexScreenerUrl: `https://dexscreener.com/${token.chain}/${current.pairAddress}`,
      imageUrls: await buildAlertImageCandidates(deps, token, current.imageUrl),
    });
    recordAlertOutcomeEntry(deps, token, "breakout", resolveMarketCapUsd(current), current, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety, true);
    logger.info(
      { address: token.address, symbol: token.symbol, volume1h, medianVolume1h: baseline.medianVolume1h },
      "Sent breakout alert"
    );
  } catch (err) {
    logger.error({ address: token.address, err: String(err) }, "Failed to send breakout alert");
  }
}

async function handleAlertedToken(deps: PollerDeps, token: TokenRow, current: ReturnType<typeof toMarketSnapshot>, now: number): Promise<void> {
  const { tokenRepo, snapshotRepo, classifierConfig, notifier, telegramChatId, dryRunAlerts, logger } = deps;

  const history = snapshotRepo.recentSince(token.address, token.status_changed_at, BASELINE_SAMPLE_LIMIT);
  if (history.length === 0) return;
  const baseline = computeBaseline(history);

  const stillReviving = meetsRevivalCriteria(
    classifierConfig,
    { volume24h: current.volume24h, volume1h: current.volume1h, buys1h: current.buys1h, liquidityUsd: current.liquidityUsd },
    baseline
  );

  if (stillReviving) {
    if (token.demote_confirm_count !== 0) {
      tokenRepo.setDemoteConfirmCount(token.address, 0);
    }
    return;
  }

  const next = token.demote_confirm_count + 1;
  if (next >= classifierConfig.demoteConfirmPolls) {
    tokenRepo.updateStatus(token.address, "dead", now);
    logger.info({ address: token.address, symbol: token.symbol }, "Demoted back to dead (revival fizzled)");

    const html = buildDemotionAlertHtml(token, current, baseline);
    if (dryRunAlerts) {
      logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send demotion alert");
    } else {
      const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${current.pairAddress}`;
      try {
        await notifier.sendAlert(telegramChatId, html, {
          dexScreenerUrl,
          imageUrls: await buildAlertImageCandidates(deps, token, current.imageUrl),
        });
        logger.info({ address: token.address, symbol: token.symbol }, "Sent demotion alert");
      } catch (err) {
        logger.error({ address: token.address, err: String(err) }, "Failed to send demotion alert");
      }
    }
  } else {
    tokenRepo.setDemoteConfirmCount(token.address, next);
  }
}

/**
 * Rechecks 'unindexed' tokens that haven't been checked in `unindexedRecheckHours`,
 * in case DexScreener has since indexed them with sufficient liquidity. Runs far
 * less often per-token than the main lookup (throttled via each token's own
 * last_checked_at), so it doesn't add meaningful load to every cycle.
 */
async function runUnindexedSweep(deps: PollerDeps, now: number, youngOnly = false): Promise<void> {
  const { tokenRepo, dex, dexScreenerChainId, logger, unindexedRecheckHours, discoveryMinLiquidityUsd } = deps;

  const cutoff = now - unindexedRecheckHours * 60 * 60 * 1000;
  // Fast lane: tokens launched within the fast-sweep window get rechecked every few
  // minutes instead of every unindexedRecheckHours, so a brand-new pair that DexScreener
  // indexes shortly after launch is promoted while its momentum window is still open —
  // previously these sat invisible for up to 24h and their early run was missed entirely.
  const youngFirstSeenCutoff = now - deps.ungraduatedFastWindowHours * 60 * 60 * 1000;
  const youngCheckedCutoff = now - YOUNG_UNINDEXED_RECHECK_MS;
  // 600 per cycle: 20 DexScreener batches, well inside the request budget, and a bounded
  // allocation. See the limit parameter's comment for the crash the old unbounded read
  // caused — this sweep, not the market scan, was what kept exhausting the heap.
  // Budgets differ by caller. The slow cycle works the whole backlog at 600 rows; the
  // fast cycle takes only the young lane at 90 (three DexScreener batches) — it used to
  // run the full 600 every 20 seconds, which alone stretched the "fast" cycle to 4-12
  // minutes and starved the launch-catching it exists for.
  const due = tokenRepo.listUnindexedDueForRecheck(
    cutoff,
    youngFirstSeenCutoff,
    youngCheckedCutoff,
    youngOnly ? 90 : 600,
    deps.ponsLaunchpadOnly,
    youngOnly
  );
  if (due.length === 0) return;

  const pairsByToken = await lookupPairsAcrossChains(deps, due);
  let promoted = 0;
  for (const token of due) {
    const pair = pickCanonicalPair(pairsByToken, token.address);
    const liquidityUsd = pair?.liquidity?.usd ?? 0;
    if (pair && liquidityUsd >= discoveryMinLiquidityUsd) {
      tokenRepo.promoteFromUnindexed(
        token.address,
        pair.baseToken.symbol ?? "?",
        pair.baseToken.name ?? pair.baseToken.symbol ?? "Unknown",
        pair.pairAddress,
        now
      );
      promoted += 1;
    } else {
      tokenRepo.markUnindexedChecked(token.address, token.not_indexed_streak + 1, now);
    }
  }
  logger.info({ checked: due.length, promoted }, "Unindexed recheck sweep complete");
}

/**
 * Rechecks on-chain graduation status for all trackable, non-'unindexed' tokens that
 * haven't graduated yet, via one batched multicall per cycle. Graduated tokens are
 * permanently excluded from future sweeps once flagged (graduation never reverses).
 * A token that newly crosses the threshold this cycle gets its own dedicated alert,
 * separate from the revival alert (which only shows graduation as passive context).
 */
export async function runGraduationSweep(deps: PollerDeps, now: number): Promise<void> {
  const {
    tokenRepo,
    chainClient,
    graduationCheckBatchSize,
    logger,
    notifier,
    telegramChatId,
    dryRunAlerts,
    dexScreenerChainId,
    dex,
  } = deps;

  // 1,500 = five multicall batches; see the query's comment for the 20-minute cycle this
  // capped.
  const due = tokenRepo.listUngraduatedTrackable(1_500);
  if (due.length === 0) return;

  const byAddress = new Map(due.map((t) => [t.address, t]));
  const calls = due.map((t) => ({ factoryAddress: t.factory_address as string, tokenAddress: t.address }));

  let results;
  try {
    results = await readGraduationStatuses(chainClient, calls, graduationCheckBatchSize, logger);
  } catch (err) {
    logger.error({ err: String(err) }, "Graduation sweep failed, will retry next cycle");
    return;
  }

  // For tokens graduating this cycle, do a small dedicated DexScreener lookup to get a
  // real market cap for the graduation alert (never fabricated — n/a if this fails).
  const newlyGraduated = results.filter((r) => r.graduated);
  const marketCapByAddress = new Map<string, number | null>();
  const snapshotByAddress = new Map<string, MarketSnapshot>();
  if (newlyGraduated.length > 0) {
    try {
      const pairs = await dex.lookupBatch(dexScreenerChainId, newlyGraduated.map((r) => r.tokenAddress));
      const pairsByToken = indexPairsByToken(pairs);
      for (const r of newlyGraduated) {
        const pair = pickCanonicalPair(pairsByToken, r.tokenAddress);
        if (pair) {
          const snap = toMarketSnapshot(pair, r.tokenAddress);
          marketCapByAddress.set(r.tokenAddress.toLowerCase(), snap.marketCapUsd);
          snapshotByAddress.set(r.tokenAddress.toLowerCase(), snap);
          if (snap.imageUrl) tokenRepo.setImageUrlIfMissing(r.tokenAddress, snap.imageUrl);
          tokenRepo.updateIdentity(r.tokenAddress, snap.symbol, snap.name);
          // Patch the in-memory token object too, mirroring updateIdentity's own guard,
          // so the alert built later in this same cycle (from `byAddress`) doesn't still
          // show a just-healed placeholder symbol/name.
          const inMemoryToken = byAddress.get(r.tokenAddress);
          if (
            inMemoryToken &&
            (inMemoryToken.symbol === "?" || inMemoryToken.name === "Unknown") &&
            snap.symbol !== "?" &&
            snap.name !== "Unknown"
          ) {
            inMemoryToken.symbol = snap.symbol;
            inMemoryToken.name = snap.name;
          }
        } else {
          marketCapByAddress.set(r.tokenAddress.toLowerCase(), null);
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "Market cap lookup for graduation alert(s) failed, will show n/a");
    }
  }

  let graduated = 0;
  for (const result of results) {
    const pairedWei = result.pairedWei.toString();
    const thresholdWei = result.thresholdWei.toString();
    if (!result.graduated) {
      tokenRepo.updateGraduationProgress(result.tokenAddress, pairedWei, thresholdWei, now);
      continue;
    }

    tokenRepo.markGraduated(result.tokenAddress, pairedWei, thresholdWei, now);
    graduated += 1;

    const token = byAddress.get(result.tokenAddress);
    if (!token) continue;

    const marketCapUsd = marketCapByAddress.get(result.tokenAddress.toLowerCase()) ?? null;
    const snap = snapshotByAddress.get(result.tokenAddress.toLowerCase()) ?? null;
    // Same rule as everywhere else: a price the pool can't support never becomes a high.
    if (isMarketCapTrustworthy(marketCapUsd, snap?.liquidityUsd ?? null, deps.minLiquidityToMcapPct)) {
      tokenRepo.updateAthMarketCap(token.address, marketCapUsd!);
    }
    const blockReason = entryAlertBlockReason(marketCapUsd, snap, alertAgeMinutes(token, now)) ?? (await convictionBlockReason(deps, token, now));
    if (blockReason) {
      recordGateBlock(deps, token, "graduation", blockReason);
      continue;
    }

    const devStatus = await resolveDevStatus(deps, token);
    const holderConcentration = await resolveHolderConcentration(deps, token);
    const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
    if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
      recordGateBlock(deps, token, "graduation", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
      continue;
    }
    const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
    if (safetyBlock) {
      recordGateBlock(deps, token, "graduation", safetyBlock);
      continue;
    }

    // Captured only once the gates pass: a baseline on a blocked coin would make the
    // gate-exempt milestone alerts fire for a coin the owner was never alerted about.
    maybeCaptureFirstAlertBaseline(deps, token, marketCapUsd, now);
    const html = buildGraduationAlertHtml(
      token,
      pairedWei,
      thresholdWei,
      token.chain,
      marketCapUsd,
      snap,
      devStatus,
      holderConcentration,
      earlyBuyConcentration,
      solanaSafety,
      rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety)
    );
    if (dryRunAlerts) {
      logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send graduation alert");
      continue;
    }
    const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${token.pair_address}`;
    try {
      await notifier.sendAlert(telegramChatId, html, {
        dexScreenerUrl,
        imageUrls: await buildAlertImageCandidates(deps, token, snap?.imageUrl),
      });
      recordAlertOutcomeEntry(deps, token, "graduation", marketCapUsd, snap, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety);
      logger.info({ address: token.address, symbol: token.symbol }, "Sent graduation alert");
    } catch (err) {
      logger.error({ address: token.address, err: String(err) }, "Failed to send graduation alert");
    }
  }
  logger.info({ checked: due.length, graduated }, "Graduation sweep complete");
}

/**
 * Fast-cycle counterpart to runGraduationSweep: tracks on-chain curve progress for
 * ungraduated tokens *including* still-'unindexed' ones (the slow sweep's
 * listUngraduatedTrackable excludes 'unindexed', leaving brand-new bonding-curve tokens
 * with zero graduation visibility until they're promoted, which can take up to
 * UNINDEXED_RECHECK_HOURS). Bounded by ungraduatedFastWindowHours so the query/RPC cost
 * stays constant regardless of total historical token count. Resolves a real on-chain
 * market cap per token (via readPoolMarketCaps — pool price is live from token creation,
 * no bonding curve involved per Pons docs) and alerts once per newly crossed market-cap
 * tier via the shared checkAndSendMarketCapTierAlert helper.
 */
export async function runUngraduatedFastSweep(deps: PollerDeps, now: number): Promise<void> {
  const {
    tokenRepo,
    chainClient,
    graduationCheckBatchSize,
    logger,
    ungraduatedFastWindowHours,
    ethPriceClient,
    notifier,
    telegramChatId,
    dryRunAlerts,
    dexScreenerChainId,
  } = deps;

  const cutoff = now - ungraduatedFastWindowHours * 60 * 60 * 1000;
  const due = tokenRepo.listUngraduatedRecentlyLaunched(cutoff).filter((t) => t.factory_address);
  if (due.length === 0) return;

  const byAddress = new Map(due.map((t) => [t.address, t]));
  const calls = due.map((t) => ({ factoryAddress: t.factory_address as string, tokenAddress: t.address }));

  let results;
  try {
    results = await readGraduationStatuses(chainClient, calls, graduationCheckBatchSize, logger);
  } catch (err) {
    logger.error({ err: String(err) }, "Ungraduated fast sweep failed, will retry next tick");
    return;
  }

  const ethUsdPrice = await ethPriceClient.getUsdPrice();

  const poolInputs = due
    .filter((t) => t.pool_address && t.pair_token_address)
    .map((t) => ({
      tokenAddress: t.address,
      poolAddress: t.pool_address as string,
      pairTokenAddress: t.pair_token_address as string,
      tokenDecimals: t.token_decimals,
      tokenTotalSupply: t.token_total_supply,
    }));

  let marketCaps: Awaited<ReturnType<typeof readPoolMarketCaps>> = [];
  if (poolInputs.length > 0 && ethUsdPrice != null) {
    try {
      marketCaps = await readPoolMarketCaps(chainClient, poolInputs, ethUsdPrice, graduationCheckBatchSize, logger);
    } catch (err) {
      logger.error({ err: String(err) }, "On-chain market cap read failed for ungraduated sweep, continuing without it");
    }
  }
  const marketCapByAddress = new Map(marketCaps.map((m) => [m.tokenAddress.toLowerCase(), m]));

  // Cache newly-resolved decimals/totalSupply so future sweeps skip the one-time lookup.
  for (const mc of marketCaps) {
    const token = byAddress.get(mc.tokenAddress);
    if (token && token.token_decimals == null) {
      tokenRepo.setTokenDecimalsAndSupply(mc.tokenAddress, mc.decimals, mc.totalSupply);
    }
  }

  let alerted = 0;
  let graduated = 0;
  for (const result of results) {
    const pairedWei = result.pairedWei.toString();
    const thresholdWei = result.thresholdWei.toString();
    const token = byAddress.get(result.tokenAddress);
    const onChainMcap = marketCapByAddress.get(result.tokenAddress.toLowerCase())?.marketCapUsd ?? null;
    // On-chain market cap is pool price × supply, so a drained pool yields nonsense — the
    // source of $66B "all-time highs" in this table. The ETH already paired into the curve
    // is a real liquidity reading and is fetched anyway, so it costs nothing to demand that
    // the price actually be backed before any high is recorded.
    const pairedLiquidityUsd = ethUsdPrice != null ? (Number(result.pairedWei) / 1e18) * ethUsdPrice : null;
    const mcapIsBacked = isMarketCapTrustworthy(onChainMcap, pairedLiquidityUsd, deps.minLiquidityToMcapPct);

    if (result.graduated) {
      tokenRepo.markGraduated(result.tokenAddress, pairedWei, thresholdWei, now);
      graduated += 1;
      if (!token) continue;

      if (mcapIsBacked) {
        tokenRepo.updateAthMarketCap(token.address, onChainMcap!);
      }
      // Send the graduation alert here rather than deferring to the slow-cycle
      // runGraduationSweep: this sweep runs far more often (20s vs 900s) and almost
      // always wins the race to mark the token graduated, but runGraduationSweep's query
      // excludes graduated=1 tokens — so without this, graduation alerts were being
      // silently and permanently dropped for the majority of tokens.
      const snap = await fetchSnapshotForToken(deps, token);
      const resolvedMcap = resolveMarketCapUsd(snap, onChainMcap);
      const blockReason = entryAlertBlockReason(resolvedMcap, snap, alertAgeMinutes(token, now)) ?? (await convictionBlockReason(deps, token, now));
      if (blockReason) {
        recordGateBlock(deps, token, "graduation", blockReason);
        continue;
      }
      const devStatus = await resolveDevStatus(deps, token);
      const holderConcentration = await resolveHolderConcentration(deps, token);
      const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
      if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
        recordGateBlock(deps, token, "graduation", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
        continue;
      }
      const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
      if (safetyBlock) {
        recordGateBlock(deps, token, "graduation", safetyBlock);
        continue;
      }
      // Captured only once the gates pass — see the same note in runGraduationSweep.
      maybeCaptureFirstAlertBaseline(deps, token, resolvedMcap, now);
      const html = buildGraduationAlertHtml(
        token,
        pairedWei,
        thresholdWei,
        token.chain,
        resolvedMcap,
        snap,
        devStatus,
        holderConcentration,
        earlyBuyConcentration,
        solanaSafety,
        rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety)
      );
      if (dryRunAlerts) {
        logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send graduation alert");
        continue;
      }
      const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${token.pair_address}`;
      try {
        await notifier.sendAlert(telegramChatId, html, {
          dexScreenerUrl,
          imageUrls: await buildAlertImageCandidates(deps, token, snap?.imageUrl),
        });
        recordAlertOutcomeEntry(deps, token, "graduation", resolvedMcap, snap, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety);
        logger.info({ address: token.address, symbol: token.symbol }, "Sent graduation alert");
      } catch (err) {
        logger.error({ address: token.address, err: String(err) }, "Failed to send graduation alert");
      }
      continue;
    }
    tokenRepo.updateGraduationProgress(result.tokenAddress, pairedWei, thresholdWei, now);

    if (!token) continue;
    if (onChainMcap == null) continue;

    if (mcapIsBacked) tokenRepo.updateAthMarketCap(token.address, onChainMcap);
    if (hasPriorAlertSignal(token)) {
      maybeCaptureFirstAlertBaseline(deps, token, onChainMcap, now);
    }
    await trackPeakMultipleAndAlert(deps, token, onChainMcap, now);
    const beforeTier = token.graduation_alert_tier;
    await checkAndSendMarketCapTierAlert(deps, token, onChainMcap, pairedWei, thresholdWei, now);
    if (deps.marketCapAlertTiersUsd.length > 0) {
      // Re-fetch isn't needed; checkAndSendMarketCapTierAlert only writes on an actual
      // crossing, which we detect for logging purposes by comparing against beforeTier.
      const tokenAfter = tokenRepo.findByAddress(token.address);
      if (tokenAfter && tokenAfter.graduation_alert_tier > beforeTier) alerted += 1;
    }
  }
  logger.info({ checked: due.length, alerted, graduated }, "Ungraduated fast sweep complete");
}

/**
 * Fast-cycle market-cap tier tracking for tokens launched outside the Pons launchpad
 * (straight onto a DEX — the majority of the chain).
 *
 * Both existing tier paths structurally excluded these coins: `runUngraduatedFastSweep`
 * requires a Pons `factory_address` for its graduationStatus multicall, and the slow
 * cycle only re-checks tiers once `graduated = 1`, which a non-Pons token never becomes.
 * The result was that a DEX-launched coin could climb from its ~$2.6k launch floor to
 * five figures without a single tier alert — it simply had no sweep watching it.
 *
 * Runs on the fast loop so the whole sub-$11k entry window is covered within seconds,
 * and is bounded by the same recency window as the other fast sweeps so its cost stays
 * constant as the token table grows.
 */
export async function runNonPonsFastSweep(deps: PollerDeps, now: number): Promise<void> {
  const { tokenRepo, logger, ungraduatedFastWindowHours } = deps;

  const cutoff = now - ungraduatedFastWindowHours * 60 * 60 * 1000;
  const due = tokenRepo.listNonPonsRecentlyLaunched(cutoff);
  if (due.length === 0) return;

  const pairsByToken = await lookupPairsAcrossChains(deps, due);

  let alerted = 0;
  for (const token of due) {
    try {
      const pair = pickCanonicalPair(pairsByToken, token.address);
      if (!pair) continue;
      const current = toMarketSnapshot(pair, token.address);

      if (current.imageUrl) tokenRepo.setImageUrlIfMissing(token.address, current.imageUrl);
      tokenRepo.updateIdentity(token.address, current.symbol, current.name);
      if ((token.symbol === "?" || token.name === "Unknown") && current.symbol !== "?" && current.name !== "Unknown") {
        token.symbol = current.symbol;
        token.name = current.name;
      }
      if (!isMarketCapTrustworthy(current.marketCapUsd, current.liquidityUsd, deps.minLiquidityToMcapPct)) continue;

      tokenRepo.updateAthMarketCap(token.address, current.marketCapUsd!);
      if (hasPriorAlertSignal(token)) {
        maybeCaptureFirstAlertBaseline(deps, token, current.marketCapUsd, now);
      }
      await trackPeakMultipleAndAlert(deps, token, current.marketCapUsd, now, current);

      const beforeTier = token.graduation_alert_tier;
      // No bonding curve off Pons, so there are no paired/threshold figures to show.
      await checkAndSendMarketCapTierAlert(deps, token, current.marketCapUsd!, "0", "0", now, current);
      const after = tokenRepo.findByAddress(token.address);
      if (after && after.graduation_alert_tier > beforeTier) alerted += 1;
    } catch (err) {
      logger.error({ address: token.address, err: String(err) }, "Error processing non-Pons token, skipping");
    }
  }
  logger.info({ checked: due.length, alerted }, "Non-Pons fast sweep complete");
}

/**
 * Fast-cycle one-shot early-momentum detector for freshly launched tokens, plus one
 * bounded follow-up re-alert if buys/volume (5m) later multiply to
 * `momentumRealertMultiple`x the original thresholds (`meetsMomentumReAlertCriteria`).
 * Scope is deliberately bounded to earlyMomentumMaxAgeMinutes (a "catch new momentum
 * early" signal, not general pump-detection across the whole token universe). Runs its
 * own DexScreener batch lookup, separate from the slow cycle's, so the fast loop never
 * waits on / competes with the full trackable-token batch.
 */
export async function runMomentumFastSweep(deps: PollerDeps, now: number): Promise<void> {
  const {
    tokenRepo,
    dex,
    dexScreenerChainId,
    logger,
    notifier,
    telegramChatId,
    dryRunAlerts,
    earlyMomentumMaxAgeMinutes,
    earlyMomentumMinBuys5m,
    earlyMomentumMinVolume5mUsd,
    momentumRealertMultiple,
  } = deps;

  const cutoff = now - earlyMomentumMaxAgeMinutes * 60 * 1000;
  const due = tokenRepo.listRecentlyLaunchedActive(cutoff);
  if (due.length === 0) return;

  const pairsByToken = await lookupPairsAcrossChains(deps, due);
  const momentumConfig = { earlyMomentumMaxAgeMinutes, earlyMomentumMinBuys5m, earlyMomentumMinVolume5mUsd };
  const reAlertConfig = { ...momentumConfig, momentumRealertMultiple };

  let alerted = 0;
  for (const token of due) {
    const pair = pickCanonicalPair(pairsByToken, token.address);
    if (!pair) continue;
    const current = toMarketSnapshot(pair, token.address);
    const ageMinutes = (now - token.first_seen_at) / (1000 * 60);

    if (current.imageUrl) tokenRepo.setImageUrlIfMissing(token.address, current.imageUrl);
    tokenRepo.updateIdentity(token.address, current.symbol, current.name);
    // Patch the in-memory token object too, mirroring updateIdentity's own guard, so
    // an alert built later in this same iteration doesn't still show a just-healed
    // placeholder symbol/name.
    if ((token.symbol === "?" || token.name === "Unknown") && current.symbol !== "?" && current.name !== "Unknown") {
      token.symbol = current.symbol;
      token.name = current.name;
    }

    if (isMarketCapTrustworthy(current.marketCapUsd, current.liquidityUsd, deps.minLiquidityToMcapPct)) {
      tokenRepo.updateAthMarketCap(token.address, current.marketCapUsd!);
    }
    if (hasPriorAlertSignal(token)) {
      maybeCaptureFirstAlertBaseline(deps, token, current.marketCapUsd, now);
    }
    await trackPeakMultipleAndAlert(deps, token, current.marketCapUsd, now, current);

    const metrics = { buys5m: current.buys5m, volume5m: current.volume5m };
    const isReAlert = token.momentum_alert_count >= 1;
    const meets = isReAlert
      ? meetsMomentumReAlertCriteria(reAlertConfig, ageMinutes, metrics)
      : meetsEarlyMomentumCriteria(momentumConfig, ageMinutes, metrics);
    if (!meets) continue;

    // Transient gate conditions (mcap over the $11k cap, links not indexed yet, zero-sell
    // hour) are checked *before* the alert counter increments, so a token that clears them
    // later in its momentum window can still get its alert. The bundle check runs after —
    // early-buy concentration is fixed at launch, so that block is permanent and the
    // incremented counter correctly suppresses endless re-checks.
    // Momentum now describes an established coin being suddenly bid, not a new pair in its
    // first hour, so it takes the established ceiling rather than the launch cap.
    const gateReason =
      entryAlertBlockReason(
        current.marketCapUsd,
        current,
        alertAgeMinutes(token, now)
      ) ?? (await convictionBlockReason(deps, token, now));
    if (gateReason) {
      recordGateBlock(deps, token, "momentum", gateReason);
      continue;
    }

    tokenRepo.incrementMomentumAlertCount(token.address);
    maybeCaptureFirstAlertBaseline(deps, token, current.marketCapUsd, now);
    const devStatus = await resolveDevStatus(deps, token);
    const holderConcentration = await resolveHolderConcentration(deps, token);
    const earlyBuyConcentration = await resolveEarlyBuyConcentration(deps, token);
    if (isOverBundleLimit(deps, earlyBuyConcentration, token, now)) {
      recordGateBlock(deps, token, "momentum", bundleBlockReason(deps, earlyBuyConcentration!, token, now));
      continue;
    }
    const { solana: solanaSafety, blockReason: safetyBlock } = await resolveChainSafety(deps, token);
    if (safetyBlock) {
      recordGateBlock(deps, token, "momentum", safetyBlock);
      continue;
    }
    const momentumXMentions = await resolveXMentions(deps, token);
    const html = buildMomentumAlertHtml(
      token,
      current,
      ageMinutes,
      token.chain,
      token.momentum_alert_count + 1,
      undefined,
      devStatus,
      holderConcentration,
      earlyBuyConcentration,
      solanaSafety,
      rateConviction(token.chain, alertAgeMinutes(token, now), solanaSafety),
      momentumXMentions
    );
    if (dryRunAlerts) {
      logger.info({ address: token.address, symbol: token.symbol, html }, "[DRY RUN] Would send momentum alert");
    } else {
      const dexScreenerUrl = `https://dexscreener.com/${token.chain}/${current.pairAddress}`;
      try {
        await notifier.sendAlert(telegramChatId, html, {
          dexScreenerUrl,
          imageUrls: await buildAlertImageCandidates(deps, token, current.imageUrl),
        });
        recordAlertOutcomeEntry(deps, token, "momentum", current.marketCapUsd, current, devStatus, holderConcentration, earlyBuyConcentration, now, solanaSafety);
        logger.info({ address: token.address, symbol: token.symbol }, "Sent momentum alert");
      } catch (err) {
        logger.error({ address: token.address, err: String(err) }, "Failed to send momentum alert");
      }
    }
    alerted += 1;
  }
  logger.info({ checked: due.length, alerted }, "Momentum fast sweep complete");
}

/**
 * Fast cycle: discovery + ungraduated curve-progress/market-cap-tier tracking + early-
 * momentum detection. Runs far more often than the full runPollCycle (which still owns
 * market-data classification, dead/revival state, and pruning). Discovery's insertIfNew
 * is idempotent, and both fast sweeps only ever perform idempotent UPDATEs, so running
 * this concurrently with runPollCycle is a safe, accepted race — at worst slightly
 * redundant work.
 */
export async function runFastCycle(deps: PollerDeps): Promise<void> {
  const { tokenRepo, dex, dexScreenerChainId, logger } = deps;
  const now = Date.now();

  try {
    await runDiscovery(
      {
        chainClient: deps.chainClient,
        discoveryStateRepo: deps.discoveryStateRepo,
        tokenRepo,
        dex,
        dexScreenerChainId,
        chunkBlocks: deps.discoveryChunkBlocks,
        maxLaunchesPerCycle: deps.discoveryMaxLaunchesPerCycle,
        minLiquidityUsd: deps.discoveryMinLiquidityUsd,
        spamDeployerThreshold: deps.spamDeployerThreshold,
        identityBatchSize: deps.graduationCheckBatchSize,
        logger,
      },
      deps.factories
    );
  } catch (err) {
    logger.error({ err: String(err) }, "Fast-cycle discovery step failed, continuing");
  }

  // Runs here as well as in the slow cycle: the young-token fast lane inside this sweep
  // only matters if it's actually evaluated frequently. Safe to race with the slow cycle —
  // all its writes are idempotent, matching this cycle's existing accepted-race model.
  // Catches Robinhood tokens launched straight onto a DEX, bypassing the Pons launchpad —
  // the majority of the chain, and previously invisible to this bot entirely.
  if (deps.dexPoolDiscoveryEnabled) {
    try {
      await runDexPoolDiscovery(
        {
          discoveryStateRepo: deps.discoveryStateRepo,
          tokenRepo,
          dex,
          minLiquidityUsd: deps.discoveryMinLiquidityUsd,
          logger,
        },
        deps.poolChainConfigs.filter((c) => activeChains(deps).includes(c.chain))
      );
    } catch (err) {
      logger.error({ err: String(err) }, "DEX pool discovery step failed, continuing");
    }
  }

  // Solana at birth, via Jupiter — seconds after pool creation, while a coin is still
  // inside the sub-$11k entry window that DexScreener's promoted feeds always miss.
  if (activeChains(deps).includes("solana")) {
    try {
      await runSolanaDiscovery({
        tokenRepo,
        jupiter: deps.jupiterClient,
        minLiquidityUsd: deps.discoveryMinLiquidityUsd,
        spamDevMintsThreshold: deps.solanaSpamDevMints,
        logger,
      });
    } catch (err) {
      logger.error({ err: String(err) }, "Solana discovery step failed, continuing");
    }
  }

  // Discovery for every chain without contract-level launch scanning (Solana/BSC/ETH).
  try {
    await runMultiChainDiscovery({
      tokenRepo,
      dex,
      enabledChains: deps.enabledChains,
      minLiquidityUsd: deps.discoveryMinLiquidityUsd,
      logger,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "Multi-chain discovery step failed, continuing");
  }

  try {
    await runUnindexedSweep(deps, now, true);
  } catch (err) {
    logger.error({ err: String(err) }, "Unindexed sweep step failed unexpectedly, continuing");
  }

  try {
    await runUngraduatedFastSweep(deps, now);
  } catch (err) {
    logger.error({ err: String(err) }, "Ungraduated fast sweep step failed unexpectedly, continuing");
  }

  // Tier coverage for DEX-launched (non-Pons) tokens, which no other sweep watches.
  // Skipped entirely in Pons-only mode: this sweep reads non-Pons tokens by definition,
  // so leaving it running would keep alerting on exactly the coins the owner scoped out.
  if (!deps.ponsLaunchpadOnly) {
    try {
      await runNonPonsFastSweep(deps, now);
    } catch (err) {
      logger.error({ err: String(err) }, "Non-Pons fast sweep step failed unexpectedly, continuing");
    }
  }

  try {
    await runMomentumFastSweep(deps, now);
  } catch (err) {
    logger.error({ err: String(err) }, "Momentum fast sweep step failed unexpectedly, continuing");
  }
}

/** Runs one full poll cycle: discovery, market data refresh, classification, alerting, demotion, pruning. */
/**
 * Heap probe for the poll cycle. Three separate memory fixes were deployed against this
 * crash on the strength of plausible-looking suspects, and it kept dying at the same point,
 * so this logs what is actually resident at each step rather than inviting a fourth guess.
 */
function logHeap(deps: PollerDeps, step: string, extra: Record<string, unknown> = {}): void {
  const m = process.memoryUsage();
  deps.logger.info(
    { step, heapMB: Math.round(m.heapUsed / 1048576), rssMB: Math.round(m.rss / 1048576), ...extra },
    "heap probe"
  );
}

export async function runPollCycle(deps: PollerDeps): Promise<void> {
  // Housekeeping runs FIRST, before anything that can fail or overrun.
  //
  // It used to be the last statement in this function, which meant it only ran if every
  // sweep before it finished. They stopped finishing (a 20-minute graduation sweep, then
  // repeated crashes), so retention silently stopped being enforced: 2,709,738 of
  // 2,721,471 snapshots were past the 3-day cutoff, the database reached 641MB with a
  // 363MB WAL beside it, and the volume filled — after which SQLite could not even open
  // ("SQLITE_IOERR_SHMSIZE") and the machine hit its restart limit. Cleanup that only
  // happens on the happy path is cleanup that stops happening exactly when it is needed.
  try {
    const retentionCutoff = Date.now() - deps.snapshotRetentionDays * 24 * 60 * 60 * 1000;
    const pruned = deps.snapshotRepo.pruneOlderThan(retentionCutoff);
    // Checkpoint every cycle: WAL growth is the other half of the same outage. Passive
    // checkpointing needs a quiet moment that a continuously-writing cycle never gives it,
    // so the WAL grew unbounded to 363MB while the main file was only 641MB.
    deps.snapshotRepo.checkpointWal();
    if (pruned > 0) deps.logger.info({ pruned }, "Pruned snapshots past retention");
  } catch (err) {
    deps.logger.error({ err: String(err) }, "Housekeeping failed, continuing");
  }

  const { tokenRepo, snapshotRepo, dex, dexScreenerChainId, logger, snapshotRetentionDays } = deps;
  const now = Date.now();

  try {
    await runDiscovery(
      {
        chainClient: deps.chainClient,
        discoveryStateRepo: deps.discoveryStateRepo,
        tokenRepo,
        dex,
        dexScreenerChainId,
        chunkBlocks: deps.discoveryChunkBlocks,
        maxLaunchesPerCycle: deps.discoveryMaxLaunchesPerCycle,
        minLiquidityUsd: deps.discoveryMinLiquidityUsd,
        spamDeployerThreshold: deps.spamDeployerThreshold,
        identityBatchSize: deps.graduationCheckBatchSize,
        logger,
      },
      deps.factories
    );
  } catch (err) {
    logger.error({ err: String(err) }, "Discovery step failed, continuing with existing tracked tokens");
  }

  // 'unindexed' tokens are excluded here — they're never-indexed/below-liquidity-floor/
  // spam-deployer tokens, only rechecked occasionally by runUnindexedSweep below.
  // Bounded to marketScanBatchSize oldest-checked tokens per cycle so the cycle can't
  // overrun its own interval (which was delaying dead→revival detection); consecutive
  // cycles round-robin through the rest, and nothing starves.
  logHeap(deps, "after-discovery-steps");
  logHeap(deps, "before-market-scan");
  const focused = activeChains(deps);
  const tracked = tokenRepo.listTrackableForCycle(
    deps.marketScanBatchSize,
    focused.length === 1 ? focused : undefined,
    deps.ponsLaunchpadOnly
  );
  logHeap(deps, "after-load-tracked", { tracked: tracked.length });
  if (tracked.length === 0) {
    logger.info("No trackable tokens yet");
  } else {
    // Processed in slices rather than in one pass. Looking the whole batch up at once
    // holds three live copies of every DexScreener pair — the accumulating results array,
    // the per-chain index, and the merged map — and at 8,000 tokens that reached the heap
    // limit and killed the process mid-cycle, every cycle, which is what kept this bot
    // offline. Heap probes measured 39MB immediately before the call and the process dead
    // before the line after it. Slicing caps the peak at one slice's worth no matter how
    // large the scan batch is, and the tokens covered per cycle are unchanged.
    let scanned = 0;
    for (let start = 0; start < tracked.length; start += MARKET_LOOKUP_SLICE_SIZE) {
      const slice = tracked.slice(start, start + MARKET_LOOKUP_SLICE_SIZE);
      // Tokens in this slice can span several chains — one request set per chain, merged.
      const pairsByToken = await lookupPairsAcrossChains(deps, slice);

      for (const token of slice) {
        try {
          const pair = pickCanonicalPair(pairsByToken, token.address);
          if (!pair) {
            // Tokens that keep coming back empty are demoted so the cycle's request budget
            // goes to coins that actually trade; the unindexed sweep still rechecks them
            // and promotes any that return.
            if (token.status === "active") {
              const streak = token.not_indexed_streak + 1;
              if (streak >= deps.noMarketDataDemoteStreak) {
                tokenRepo.demoteToUnindexed(token.address, now);
                logger.info({ address: token.address, symbol: token.symbol, streak }, "Demoted quiet token to unindexed");
              } else {
                tokenRepo.setNoMarketDataStreak(token.address, streak);
              }
            }
            continue;
          }
          const current = toMarketSnapshot(pair, token.address);
          if (token.not_indexed_streak !== 0) tokenRepo.setNoMarketDataStreak(token.address, 0);

          if (current.imageUrl) tokenRepo.setImageUrlIfMissing(token.address, current.imageUrl);
          tokenRepo.updateIdentity(token.address, current.symbol, current.name);
          // Patch the in-memory token object too, mirroring updateIdentity's own guard, so
          // an alert built later in this same iteration doesn't still show a just-healed
          // placeholder symbol/name.
          if (
            (token.symbol === "?" || token.name === "Unknown") &&
            current.symbol !== "?" &&
            current.name !== "Unknown"
          ) {
            token.symbol = current.symbol;
            token.name = current.name;
          }

          // A drained pool reports a meaningless market cap; recording it would corrupt
          // the ATH, the peak multiple and the observer's winner/dumper labels alike.
          if (isMarketCapTrustworthy(current.marketCapUsd, current.liquidityUsd, deps.minLiquidityToMcapPct)) {
            tokenRepo.updateAthMarketCap(token.address, current.marketCapUsd!);
          }
          if (hasPriorAlertSignal(token)) {
            maybeCaptureFirstAlertBaseline(deps, token, current.marketCapUsd, now);
          }

          // Nothing below can fire for a coin with no trade in the last hour. Every signal
          // this bot now sends — a breakout, a revival, a milestone — describes a coin
          // people are buying, and "people are buying" is exactly buys1h > 0. Most of the
          // table fails that test at any moment: it is tens of thousands of dead launches
          // whose numbers cannot have changed since the last pass.
          //
          // Running the full handler chain over them anyway was most of the cycle's work
          // and all of its risk — the market-scan loop is where the process kept dying on
          // the heap limit at every batch size tried (8000, 1500 and 400 all crashed, the
          // smaller ones sooner, because a shorter loop reaches the bad step faster). The
          // snapshot is still written below, so baselines stay continuous and a coin that
          // starts trading is picked up on the very next pass.
          scanned += 1;
          const hasLiveTrade = (current.buys1h ?? 0) > 0 || (current.volume1h ?? 0) > 0;
          // Recorded on the row so the next cycle's scan can prioritise this coin cheaply.
          if (hasLiveTrade) tokenRepo.markTraded(token.address, now);
          if (!hasLiveTrade && !hasPriorAlertSignal(token)) {
            snapshotRepo.insert(current, now);
            continue;
          }

          await trackPeakMultipleAndAlert(deps, token, current.marketCapUsd, now, current);

          // Market-cap tier alerts continue past graduation (pre-graduation coverage is
          // owned by runUngraduatedFastSweep) — once graduated=1, this is the only sweep
          // still tracking the token, so it's the natural place to keep tier alerts alive.
          // Graduated Pons tokens (the fast sweep drops them once graduated) plus
          // non-Pons tokens past the fast window — neither has another tier watcher.
          if (current.marketCapUsd != null && (token.graduated || token.factory_address == null)) {
            await checkAndSendMarketCapTierAlert(
              deps,
              token,
              current.marketCapUsd,
              token.graduation_paired_wei ?? "0",
              token.graduation_threshold_wei ?? "0",
              now,
              current
            );
          }

          if (token.status === "dead" || token.status === "alerted") {
            // Baseline must be computed from history *before* this cycle's snapshot is inserted.
            if (token.status === "dead") {
              await handleDeadToken(deps, token, current, now);
              // Dead coins also get the reversal check. Revival only fires on a volume
              // surge against the dead-period baseline, so a coin whose *price* turns up
              // off its floor on ordinary volume passed through here unnoticed — which is
              // the single largest category of miss reported against this bot. The handler
              // evaluates dead coins for reversal only; a volume surge here is revival's
              // job and the shared alert cooldown stops both firing on the same move.
              await handleBreakoutCandidate(deps, token, current, now);
            } else {
              await handleAlertedToken(deps, token, current, now);
            }
          } else if (token.status === "active") {
            const ageHrs = ageHours(now, token.first_seen_at);
            handleActiveToken(deps, token, ageHrs, current, now);
            // Baseline must come from prior history, so this runs before the insert below.
            await handleBreakoutCandidate(deps, token, current, now);
          }

          snapshotRepo.insert(current, now);
        } catch (err) {
          logger.error({ address: token.address, err: String(err) }, "Error processing token this cycle, skipping");
        }
      }

      // Stamped for every token in this slice, including ones with no market data this
      // pass — otherwise a permanently-unindexed token would pin the round-robin cursor
      // and starve the rest of the table.
      tokenRepo.markMarketChecked(tracked.map((t) => t.address), now);
      logger.info({ scanned: tracked.length, batchSize: deps.marketScanBatchSize }, "Market scan slice complete");
    }
  }

  logHeap(deps, "after-market-scan-loop");

  try {
    await runUnindexedSweep(deps, now);
  } catch (err) {
    logger.error({ err: String(err) }, "Unindexed sweep step failed unexpectedly, continuing");
  }

  try {
    await runGraduationSweep(deps, now);
    logHeap(deps, "after-graduation-sweep");
  } catch (err) {
    logger.error({ err: String(err) }, "Graduation sweep step failed unexpectedly, continuing");
  }

  try {
    await runObserverSweep(deps, now);
    logHeap(deps, "after-observer-sweep");
  } catch (err) {
    logger.error({ err: String(err) }, "Observer sweep step failed unexpectedly, continuing");
  }

}

export interface PollerOptions {
  /** The cycle function to run on each tick (e.g. runPollCycle or runFastCycle). */
  run: () => Promise<void>;
  intervalSeconds: number;
  /** Short label used in log lines to distinguish concurrently-running pollers (e.g. "slow", "fast"). */
  label: string;
  logger: Logger;
}

/** Schedules an injected cycle function on an interval, with an in-flight guard so overlapping cycles can't stack. */
export class Poller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastRunAt: number | undefined;
  private cycleStartedAt: number | undefined;

  constructor(private readonly options: PollerOptions) {}

  getLastRunAt(): number | undefined {
    return this.lastRunAt;
  }

  start(): void {
    const { intervalSeconds, logger, label } = this.options;
    logger.info({ intervalSeconds, label }, "Starting poller");
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalSeconds * 1000);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.options.logger.info({ label: this.options.label }, "Poller stopped");
  }

  async runOnce(): Promise<void> {
    const { run, intervalSeconds, logger, label } = this.options;
    if (this.running) {
      const inFlightMs = this.cycleStartedAt ? Date.now() - this.cycleStartedAt : undefined;
      logger.warn({ inFlightMs, label }, "Previous cycle still running, skipping this tick");
      return;
    }
    this.running = true;
    this.cycleStartedAt = Date.now();
    try {
      await run();
      this.lastRunAt = Date.now();
      const durationMs = this.lastRunAt - this.cycleStartedAt;
      const overran = durationMs > intervalSeconds * 1000;
      logger[overran ? "warn" : "info"]({ durationMs, intervalMs: intervalSeconds * 1000, overran, label }, "Cycle complete");
    } catch (err) {
      logger.error({ err: String(err), label }, "Cycle failed unexpectedly");
    } finally {
      this.running = false;
      this.cycleStartedAt = undefined;
    }
  }
}
