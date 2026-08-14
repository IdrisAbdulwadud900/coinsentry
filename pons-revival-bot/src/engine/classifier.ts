/**
 * Pure classification functions implementing the dead/revival/demotion rules
 * from the build spec (sections 5 & 6). No DB or I/O here — the poller reads
 * state, calls these, and persists the results. Keeping this pure makes the
 * thresholds easy to unit test in isolation.
 */

export interface ClassifierConfig {
  deadMinAgeHours: number;
  deadVolume24hUsd: number;
  deadMinBuys1h: number;
  deadConfirmPolls: number;
  revivalVolumeMultiple: number;
  revivalMinVolume1hUsd: number;
  revivalMinBuys1h: number;
  revivalLiquidityFloorPct: number;
  revivalConfirmPolls: number;
  demoteConfirmPolls: number;
  alertCooldownHours: number;
}

/** All 11 ClassifierConfig field names, used both as the /setconfig|/resetconfig
 * allow-list and to drive the /config listing — kept in one place so a new field can't
 * be added to the interface without also being wired into the writable-settings surface. */
export const CLASSIFIER_CONFIG_KEYS: (keyof ClassifierConfig)[] = [
  "deadMinAgeHours",
  "deadVolume24hUsd",
  "deadMinBuys1h",
  "deadConfirmPolls",
  "revivalVolumeMultiple",
  "revivalMinVolume1hUsd",
  "revivalMinBuys1h",
  "revivalLiquidityFloorPct",
  "revivalConfirmPolls",
  "demoteConfirmPolls",
  "alertCooldownHours",
];

/**
 * Builds a live ClassifierConfig backed by per-field getters: each read checks
 * settingsRepo for a stored override (parsed as a finite number) at access time, falling
 * back to the env-sourced default otherwise. No consumer (poller.ts, server/app.ts)
 * destructures ClassifierConfig at module load — every field is read fresh per call — so
 * a getter-backed object is a drop-in replacement for the old plain object literal.
 */
export function buildClassifierConfig(
  defaults: ClassifierConfig,
  settingsRepo: { get(key: string): string | undefined }
): ClassifierConfig {
  const config = {} as ClassifierConfig;
  for (const key of CLASSIFIER_CONFIG_KEYS) {
    Object.defineProperty(config, key, {
      enumerable: true,
      get(): number {
        const raw = settingsRepo.get(key);
        if (raw == null) return defaults[key];
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : defaults[key];
      },
    });
  }
  return config;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function ageHours(nowMs: number, firstSeenAtMs: number): number {
  return (nowMs - firstSeenAtMs) / (1000 * 60 * 60);
}

export interface LatestMetrics {
  volume24h: number | null;
  volume1h: number | null;
  buys1h: number | null;
  liquidityUsd: number | null;
}

/**
 * A single poll's snapshot meets the "dead" shape (age, volume, buys).
 * The "sustained over N consecutive polls" part is the caller's job via a
 * confirm counter, since that requires cross-poll state.
 */
export function meetsDeadCriteria(config: ClassifierConfig, ageHrs: number, latest: LatestMetrics): boolean {
  return (
    ageHrs >= config.deadMinAgeHours &&
    (latest.volume24h ?? 0) < config.deadVolume24hUsd &&
    (latest.buys1h ?? 0) < config.deadMinBuys1h
  );
}

export interface Baseline {
  medianVolume1h: number;
  medianLiquidityUsd: number;
  sampleSize: number;
  /** Lowest price seen across the sampled window — the "floor" a reversal bounces off.
   * Null when no sample carried a usable price. */
  minPriceUsd: number | null;
}

export function computeBaseline(
  history: { volume_1h: number | null; liquidity_usd: number | null; price_usd?: number | null }[]
): Baseline {
  const prices = history.map((h) => h.price_usd ?? 0).filter((p) => p > 0);
  return {
    medianVolume1h: median(history.map((h) => h.volume_1h ?? 0)),
    medianLiquidityUsd: median(history.map((h) => h.liquidity_usd ?? 0)),
    sampleSize: history.length,
    minPriceUsd: prices.length > 0 ? Math.min(...prices) : null,
  };
}

/**
 * All 4 revival conditions from spec section 6, each independently capable
 * of blocking a false trigger:
 *  1. volume_1h >= 8x the dead-period median hourly volume
 *  2. volume_1h >= absolute $ floor (so 8x of near-zero doesn't false-trigger)
 *  3. buys_1h >= minimum buy count
 *  4. liquidity_usd >= floor% of the dead-period median liquidity (rug guard)
 */
export function meetsRevivalCriteria(config: ClassifierConfig, current: LatestMetrics, baseline: Baseline): boolean {
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;
  const liquidity = current.liquidityUsd ?? 0;

  const volumeMultipleOk = volume1h >= baseline.medianVolume1h * config.revivalVolumeMultiple;
  const volumeFloorOk = volume1h >= config.revivalMinVolume1hUsd;
  const buysOk = buys1h >= config.revivalMinBuys1h;
  const liquidityOk = liquidity >= baseline.medianLiquidityUsd * config.revivalLiquidityFloorPct;

  return volumeMultipleOk && volumeFloorOk && buysOk && liquidityOk;
}

/** Thresholds for the breakout signal — a coin accelerating against its own history,
 * at any age. Deliberately separate from the revival thresholds: revival asks "did a dead
 * coin come back", breakout asks "is this coin running right now". */
export interface BreakoutConfig {
  breakoutVolumeMultiple: number;
  breakoutMinVolume1hUsd: number;
  breakoutMinBuys1h: number;
}

/**
 * True when a coin is genuinely surging relative to its own trailing baseline.
 *
 * This is what catches a coin making the 2k→high move on its own schedule rather than in
 * its first five minutes — the case every other alert path misses, because momentum is
 * capped at 60 minutes old and the high-conviction window at 5. The absolute floors matter
 * as much as the multiple: a quiet coin going from $20 to $200 of hourly volume is a 10x
 * multiple and still nothing worth acting on.
 */
export function meetsBreakoutCriteria(config: BreakoutConfig, current: LatestMetrics, baseline: Baseline): boolean {
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;

  // Needs a real baseline to be a real comparison; a single prior sample proves nothing.
  if (baseline.sampleSize < 3) return false;

  const volumeMultipleOk = volume1h >= baseline.medianVolume1h * config.breakoutVolumeMultiple;
  const volumeFloorOk = volume1h >= config.breakoutMinVolume1hUsd;
  const buysOk = buys1h >= config.breakoutMinBuys1h;

  return volumeMultipleOk && volumeFloorOk && buysOk;
}

/**
 * A coin turning back up off its floor.
 *
 * meetsBreakoutCriteria is purely volume-and-buys, so it only ever sees a coin that is
 * *already* being hammered. A reversal looks different: price has bottomed and started
 * climbing while volume may still be ordinary, which is precisely the moment worth knowing
 * about and precisely what the volume test cannot express. Coins recovering off the floor
 * were being missed for exactly this reason.
 *
 * The price must be meaningfully above the window's low (not noise), there must be real
 * buying behind the move rather than a single trade lifting a thin pool, and — as with
 * every other signal here — the reading is only trusted when the pool can support it.
 */
export function meetsReversalCriteria(
  config: { reversalMultiple: number; breakoutMinBuys1h: number; breakoutMinVolume1hUsd: number },
  current: LatestMetrics & { priceUsd?: number | null },
  baseline: Baseline
): boolean {
  if (baseline.sampleSize < 3) return false;
  const floor = baseline.minPriceUsd;
  const price = current.priceUsd ?? 0;
  if (floor == null || floor <= 0 || price <= 0) return false;

  const recoveredOffFloor = price >= floor * config.reversalMultiple;
  // Half the breakout thresholds: a reversal is caught earlier than a full breakout, so
  // demanding breakout-sized volume would defeat the point — but it still has to be a
  // crowd, not one buyer walking a dead pool up.
  const buysOk = (current.buys1h ?? 0) >= Math.max(3, Math.floor(config.breakoutMinBuys1h / 2));
  const volumeOk = (current.volume1h ?? 0) >= config.breakoutMinVolume1hUsd / 2;

  return recoveredOffFloor && buysOk && volumeOk;
}

export function isInCooldown(lastAlertAtMs: number | null, nowMs: number, cooldownHours: number): boolean {
  if (lastAlertAtMs == null) return false;
  return nowMs - lastAlertAtMs < cooldownHours * 60 * 60 * 1000;
}

export interface MomentumConfig {
  earlyMomentumMaxAgeMinutes: number;
  earlyMomentumMinBuys5m: number;
  earlyMomentumMinVolume5mUsd: number;
}

export interface MomentumMetrics {
  buys5m: number | null;
  volume5m: number | null;
}

/**
 * A freshly-launched token (age since first_seen_at within the max-age window) is
 * showing early buy/volume acceleration. Deliberately separate from the dead/revival
 * state machine above — this is a one-shot "new momentum" signal, not a status
 * transition, and callers gate on the token's own `momentum_alert_sent` flag to
 * ensure it only ever fires once per token.
 */
export function meetsEarlyMomentumCriteria(config: MomentumConfig, ageMinutes: number, current: MomentumMetrics): boolean {
  return (
    ageMinutes <= config.earlyMomentumMaxAgeMinutes &&
    (current.buys5m ?? 0) >= config.earlyMomentumMinBuys5m &&
    (current.volume5m ?? 0) >= config.earlyMomentumMinVolume5mUsd
  );
}

export interface MomentumReAlertConfig extends MomentumConfig {
  momentumRealertMultiple: number;
}

/**
 * Bounded follow-up momentum alert (fires at most once, after the original one-shot
 * alert already fired — callers gate on `momentum_alert_count < 2`). Fires only if
 * buys/volume (5m) have grown to at least `momentumRealertMultiple` times the
 * *original* one-shot thresholds — a simple multiplier on the original bar, not a
 * comparison against the exact first-alert snapshot (avoids persisting that snapshot
 * just for this one check, while still being a meaningfully higher, bounded bar).
 */
export function meetsMomentumReAlertCriteria(
  config: MomentumReAlertConfig,
  ageMinutes: number,
  current: MomentumMetrics
): boolean {
  return (
    ageMinutes <= config.earlyMomentumMaxAgeMinutes &&
    (current.buys5m ?? 0) >= config.earlyMomentumMinBuys5m * config.momentumRealertMultiple &&
    (current.volume5m ?? 0) >= config.earlyMomentumMinVolume5mUsd * config.momentumRealertMultiple
  );
}
