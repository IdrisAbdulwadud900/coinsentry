import type { Db } from "./db.js";
import type { TokenRow, TokenStatus } from "../types/domain.js";
import { normalizeAddress, DEFAULT_CHAIN } from "./chains.js";

/** How recently a coin must have traded to join the priority ("hot") scan set. */
const HOT_SET_WINDOW_MS = 24 * 60 * 60 * 1000;

export class TokenRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts a newly discovered token if it doesn't already exist. `status` is either
   * 'active' (DexScreener has real data with sufficient liquidity) or 'unindexed'
   * (not yet indexed, below the liquidity floor, or a known spam deployer) — callers
   * decide which at discovery time. No-op if the address is already tracked.
   */
  insertIfNew(
    address: string,
    symbol: string,
    name: string,
    pairAddress: string,
    status: TokenStatus,
    deployerAddress: string | null,
    factoryAddress: string | null,
    now: number,
    poolAddress: string | null = null,
    pairTokenAddress: string | null = null,
    launchBlock: string | null = null,
    chain: string = DEFAULT_CHAIN
  ): void {
    const notIndexedStreak = status === "unindexed" ? 1 : 0;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tokens
          (address, symbol, name, pair_address, first_seen_at, status, status_changed_at,
           deployer_address, not_indexed_streak, last_checked_at, factory_address,
           pool_address, pair_token_address, launch_block, chain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizeAddress(address),
        symbol,
        name,
        pairAddress,
        now,
        status,
        now,
        deployerAddress ? normalizeAddress(deployerAddress) : null,
        notIndexedStreak,
        now,
        factoryAddress ? normalizeAddress(factoryAddress) : null,
        poolAddress ? normalizeAddress(poolAddress) : null,
        pairTokenAddress ? normalizeAddress(pairTokenAddress) : null,
        launchBlock,
        chain
      );
  }

  /** Token counts per chain, for the /status chain breakdown. */
  countByChain(): { chain: string; count: number }[] {
    return this.db
      .prepare<
        [],
        { chain: string; count: number }
      >("SELECT chain, COUNT(*) as count FROM tokens WHERE status != 'unindexed' GROUP BY chain ORDER BY count DESC")
      .all();
  }

  findByAddress(address: string): TokenRow | undefined {
    return this.db
      .prepare<[string], TokenRow>("SELECT * FROM tokens WHERE address = ?")
      .get(normalizeAddress(address));
  }

  listByStatus(status: TokenStatus): TokenRow[] {
    return this.db.prepare<[string], TokenRow>("SELECT * FROM tokens WHERE status = ?").all(status);
  }

  listAll(): TokenRow[] {
    return this.db.prepare<[], TokenRow>("SELECT * FROM tokens").all();
  }

  /** Tokens eligible for the main per-cycle DexScreener lookup — excludes 'unindexed'
   * tokens, which are only rechecked via the separate low-frequency sweep. */
  listTrackable(): TokenRow[] {
    return this.db.prepare<[], TokenRow>("SELECT * FROM tokens WHERE status != 'unindexed'").all();
  }

  /**
   * One bounded slice of the trackable set for this cycle. Keeps each poll cycle's
   * DexScreener cost constant as the token table grows — without this, scanning every
   * trackable token made the cycle overrun its own interval.
   *
   * Ordering is deliberate: 'dead'/'alerted' tokens come first (they're the revival
   * candidates — the whole point of the bot — so as long as they fit in the budget they
   * are re-checked every single cycle, giving the fastest possible revival detection),
   * then everything else round-robins oldest-checked-first so no token ever starves.
   */
  listTrackableForCycle(
    limit: number,
    chains?: string[],
    ponsOnly = false,
    ponsFactory?: string | null,
    /**
     * Event-driven mode: only consider coins the chain has shown activity for since this
     * timestamp, instead of round-robining the whole registry.
     *
     * Polling every stored coin is backwards — cost grows with how many dead coins have
     * ever existed, and a coin that starts moving waits its turn behind them. The swap
     * scan already reports who is being bought and the factory scan reports what just
     * launched, so those two feeds decide what deserves a look. Anything the chain has not
     * mentioned recently is, by definition, not doing anything.
     */
    activeSinceMs?: number | null
  ): TokenRow[] {
    // Pons-only mode narrows the scan to coins that came from the two Pons launchpad
    // factories, ignoring everything discovered by watching DEX pools directly. Those DEX
    // scans pulled in the whole chain — 458,000 tokens against roughly 20,000 launchpad
    // coins — and the scan budget was spread across all of it.
    // ponsFactory narrows further to ONE launchpad version (v2 in production). v1 is a
    // retired launchpad whose 1,739 coins are almost entirely dead; excluding them keeps
    // the budget on the launchpad that still mints.
    // An explicit allowlist, not merely "has a launchpad". Any-launchpad let coins from
    // pads the owner never asked for (pump.fun, which out-launches everything else on
    // Solana) consume the scan budget and reach alerts. Entries are validated before being
    // interpolated, since the filter varies the statement shape and cannot be bound.
    const allowed = (ponsFactory ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => /^[A-Za-z0-9_.\-]+$/.test(v));
    const ponsFilter = allowed.length > 0
      ? ` AND t.factory_address COLLATE NOCASE IN (${allowed.map((v) => `'${v}'`).join(", ")})`
      : ponsOnly
        ? " AND t.factory_address IS NOT NULL"
        : "";
    // A freshly-launched coin has no trade yet, so first_seen_at counts as activity too —
    // otherwise the new-pair half of the strategy would never be looked at.
    const activityFilter = activeSinceMs != null ? " AND (t.last_traded_at > ? OR t.first_seen_at > ?)" : "";
    // Focus mode narrows the scan to one chain, which spends the whole per-cycle budget
    // there instead of spreading it — the same budget then revisits each of that chain's
    // coins far more often.
    if (chains && chains.length > 0) {
      const placeholders = chains.map(() => "?").join(", ");
      return this.db
        .prepare<(string | number)[], TokenRow>(
          // Same activity-first ordering as the unfocused path below; see the comment there.
          `SELECT t.* FROM tokens t
           WHERE t.status != 'unindexed' AND t.chain IN (${placeholders})${ponsFilter}
           ORDER BY (CASE WHEN t.last_traded_at > ? THEN 0 ELSE 1 END) ASC,
                    (CASE WHEN t.status IN ('dead', 'alerted') THEN 0 ELSE 1 END) ASC,
                    COALESCE(t.market_checked_at, 0) ASC
           LIMIT ?`
        )
        .all(...chains, Date.now() - HOT_SET_WINDOW_MS, limit);
    }
    return this.db
      .prepare<number[], TokenRow>(
        // Coins that have actually traded recently come first, read from an indexed column
        // on the row itself. The first version of this correlated a subquery against the
        // 2.4M-row snapshots table for every one of 57,000 tokens on every cycle, and the
        // process began dying on the heap limit within ~5 minutes at every batch size tried
        // (4000, 350 and 120 alike) — the cost was in the ordering, not the batch.
        //
        // Even ordering was the single largest cause of missed moves: the budget was spent
        // mostly on coins that had not traded in a day, while a coin that was moving right
        // now waited its turn behind them. A surge lasting an hour cannot be caught by a
        // scan that comes round every 40. The tail still round-robins oldest-first behind
        // the hot set, so nothing starves.
        `SELECT t.* FROM tokens t
         WHERE t.status != 'unindexed'${ponsFilter}${activityFilter}
         ORDER BY (CASE WHEN t.last_traded_at > ? THEN 0 ELSE 1 END) ASC,
                  (CASE WHEN t.status IN ('dead', 'alerted') THEN 0 ELSE 1 END) ASC,
                  COALESCE(t.market_checked_at, 0) ASC
         LIMIT ?`
      )
      .all(
        Date.now() - HOT_SET_WINDOW_MS,
        ...(activeSinceMs != null ? [activeSinceMs, activeSinceMs] : []),
        limit
      );
  }

  /** Stamps a batch of tokens as market-checked, in one transaction (per-row autocommit
   * would fsync once per token and dominate the cycle's runtime). */
  /** Stamps when a coin was last seen trading, so the scan can prioritise it without
   * joining the snapshots table on every cycle. */
  /**
   * Tokens whose pool is in `poolAddresses` — the bridge from a swap log back to a coin.
   *
   * Chunked because SQLite caps a statement at 999 bound parameters, and a busy minute of
   * chain yields a few hundred pools.
   */
  listByPairAddresses(poolAddresses: string[]): TokenRow[] {
    const out: TokenRow[] = [];
    for (let i = 0; i < poolAddresses.length; i += 400) {
      const batch = poolAddresses.slice(i, i + 400);
      const placeholders = batch.map(() => "?").join(", ");
      out.push(
        ...this.db
          .prepare<string[], TokenRow>(
            `SELECT * FROM tokens WHERE pair_address COLLATE NOCASE IN (${placeholders})`
          )
          .all(...batch)
      );
    }
    return out;
  }

  /** Sends an unindexed token to the front of the recheck queue (which orders by
   * oldest-checked), so a coin seen trading is resolved on the next pass rather than
   * whenever its turn happens to come. */
  /** Records the pool a coin trades in, learned from a swap log. Only fills a missing
   * value — an existing pair_address came from DexScreener and is authoritative. */
  setPairAddressIfMissing(address: string, pairAddress: string): void {
    this.db
      .prepare("UPDATE tokens SET pair_address = ? WHERE address = ? AND (pair_address IS NULL OR pair_address = '')")
      .run(pairAddress, normalizeAddress(address));
  }

  markUnindexedForImmediateRecheck(address: string): void {
    this.db
      .prepare("UPDATE tokens SET last_checked_at = 0 WHERE address = ? AND status = 'unindexed'")
      .run(normalizeAddress(address));
  }

  markTraded(address: string, now: number): void {
    this.db.prepare("UPDATE tokens SET last_traded_at = ? WHERE address = ?").run(now, normalizeAddress(address));
  }

  markMarketChecked(addresses: string[], now: number): void {
    if (addresses.length === 0) return;
    const stmt = this.db.prepare("UPDATE tokens SET market_checked_at = ? WHERE address = ?");
    this.db.transaction((batch: string[]) => {
      for (const address of batch) stmt.run(now, normalizeAddress(address));
    })(addresses);
  }

  /** 'unindexed' tokens due for a recheck: never checked, checked before the slow cutoff,
   * or — the fast lane — launched recently (first_seen_at >= youngFirstSeenCutoff) and not
   * checked within the much shorter young-token interval. The fast lane exists so a brand-new
   * pair that gets indexed by DexScreener minutes after launch is promoted to 'active' while
   * its momentum window is still open, instead of waiting up to UNINDEXED_RECHECK_HOURS. */
  listUnindexedDueForRecheck(
    cutoffTs: number,
    youngFirstSeenCutoff: number,
    youngCheckedCutoff: number,
    /**
     * Hard row cap. Unbounded, this query WAS the crash that kept killing the bot: with
     * 400,698 unindexed tokens, any downtime made the whole backlog due at once and one
     * .all() materialised ~400MB of rows — the exact single-allocation signature in the
     * GC logs (Mark-Compact 511.4 -> 511.2MB, nothing reclaimable), and invisible to every
     * market-scan-sized knob because this sweep never read any of them. Young tokens sort
     * first so a fresh pair's fast lane still works, then oldest-checked round-robins.
     */
    limit: number,
    /** In Pons-only mode the 400k DEX-discovered unindexed rows are skipped outright:
     * left in, they would consume the entire per-cycle budget for ~55 hours per pass
     * while every Pons coin waited behind them. */
    ponsOnly = false,
    /** Restrict to the young fast lane entirely — used by the fast cycle, whose whole
     * purpose is promoting brand-new pairs the moment DexScreener indexes them. */
    youngOnly = false,
    /** Narrow to one launchpad version; see listTrackableForCycle. */
    ponsFactory?: string | null
  ): TokenRow[] {
    // Same allowlist as listTrackableForCycle; see the comment there.
    const allowed = (ponsFactory ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => /^[A-Za-z0-9_.\-]+$/.test(v));
    const ponsFilter = allowed.length > 0
      ? ` AND factory_address COLLATE NOCASE IN (${allowed.map((v) => `'${v}'`).join(", ")})`
      : ponsOnly
        ? " AND factory_address IS NOT NULL"
        : "";
    const youngFilter = youngOnly ? " AND first_seen_at >= ?" : "";
    return this.db
      .prepare<
        number[],
        TokenRow
      >(
        `SELECT * FROM tokens WHERE status = 'unindexed'${ponsFilter}${youngFilter} AND (
           last_checked_at IS NULL
           OR last_checked_at < ?
           OR (first_seen_at >= ? AND last_checked_at < ?)
         )
         ORDER BY (CASE WHEN first_seen_at >= ? THEN 0 ELSE 1 END) ASC,
                  COALESCE(last_checked_at, 0) ASC
         LIMIT ?`
      )
      .all(
        ...(youngOnly ? [youngFirstSeenCutoff] : []),
        cutoffTs,
        youngFirstSeenCutoff,
        youngCheckedCutoff,
        youngFirstSeenCutoff,
        limit
      );
  }

  /** Count of tokens already attributed to a deployer, used to detect mass-spam launchers. */
  countByDeployer(deployerAddress: string): number {
    const row = this.db
      .prepare<[string], { count: number }>("SELECT COUNT(*) as count FROM tokens WHERE deployer_address = ?")
      .get(normalizeAddress(deployerAddress));
    return row?.count ?? 0;
  }

  countByStatus(): Record<TokenStatus, number> {
    const rows = this.db
      .prepare<[], { status: TokenStatus; count: number }>(
        "SELECT status, COUNT(*) as count FROM tokens GROUP BY status"
      )
      .all();
    const result: Record<TokenStatus, number> = { active: 0, dead: 0, reviving: 0, alerted: 0, unindexed: 0 };
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }

  updateStatus(address: string, status: TokenStatus, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET status = ?, status_changed_at = ?,
          dead_confirm_count = 0, revival_confirm_count = 0, demote_confirm_count = 0
         WHERE address = ?`
      )
      .run(status, now, normalizeAddress(address));
  }

  setDeadConfirmCount(address: string, count: number): void {
    this.db
      .prepare("UPDATE tokens SET dead_confirm_count = ? WHERE address = ?")
      .run(count, normalizeAddress(address));
  }

  setRevivalConfirmCount(address: string, count: number): void {
    this.db
      .prepare("UPDATE tokens SET revival_confirm_count = ? WHERE address = ?")
      .run(count, normalizeAddress(address));
  }

  setDemoteConfirmCount(address: string, count: number): void {
    this.db
      .prepare("UPDATE tokens SET demote_confirm_count = ? WHERE address = ?")
      .run(count, normalizeAddress(address));
  }

  setLastAlertAt(address: string, ts: number): void {
    this.db
      .prepare("UPDATE tokens SET last_alert_at = ? WHERE address = ?")
      .run(ts, normalizeAddress(address));
  }

  /**
   * Transitions a token to 'alerted' without resetting status_changed_at, since
   * that timestamp anchors the dead-period baseline (median volume/liquidity)
   * that the demotion check still needs to compare against after the alert fires.
   */
  markAlerted(address: string, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET status = 'alerted', last_alert_at = ?,
          revival_confirm_count = 0, demote_confirm_count = 0
         WHERE address = ?`
      )
      .run(now, normalizeAddress(address));
  }

  /** DexScreener now has data (with sufficient liquidity) for a previously 'unindexed'
   * token — promote it to 'active' with a fresh first_seen_at, since its real market
   * life is only starting now as far as the dead/revival age-based criteria are concerned. */
  promoteFromUnindexed(address: string, symbol: string, name: string, pairAddress: string, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET status = 'active', symbol = ?, name = ?, pair_address = ?,
          first_seen_at = ?, status_changed_at = ?, not_indexed_streak = 0, last_checked_at = ?,
          dead_confirm_count = 0, revival_confirm_count = 0, demote_confirm_count = 0
         WHERE address = ?`
      )
      .run(symbol, name, pairAddress, now, now, now, normalizeAddress(address));
  }

  /** Self-heals a token's symbol/name once real data becomes available for a token that
   * was inserted with a placeholder identity ("?" / "Unknown") — DexScreener can lag on
   * indexing baseToken.name/symbol for brand-new pairs, and 'active' tokens otherwise never
   * get their identity rechecked after insertion. Guarded both ways: never overwrites a
   * real identity that's already stored, and never writes an incoming placeholder value. */
  updateIdentity(address: string, symbol: string, name: string): void {
    if (symbol === "?" || name === "Unknown") return;
    this.db
      .prepare(
        `UPDATE tokens SET symbol = ?, name = ?
         WHERE address = ? AND (symbol = '?' OR name = 'Unknown')`
      )
      .run(symbol, name, normalizeAddress(address));
  }

  /** Still not indexed / still below the liquidity floor — bump the streak and checked timestamp. */
  markUnindexedChecked(address: string, streak: number, now: number): void {
    this.db
      .prepare("UPDATE tokens SET not_indexed_streak = ?, last_checked_at = ? WHERE address = ?")
      .run(streak, now, normalizeAddress(address));
  }

  /** Dead tokens that have at least one confirmed revival poll so far (not yet enough to alert). */
  countRevivingCandidates(): number {
    const row = this.db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM tokens WHERE status = 'dead' AND revival_confirm_count > 0")
      .get();
    return row?.count ?? 0;
  }

  /** Tokens with no recorded origin factory (all discovered before factory_address was
   * captured at discovery time) — candidates for the one-off factory-address backfill. */
  listMissingFactoryAddress(): TokenRow[] {
    return this.db.prepare<[], TokenRow>("SELECT * FROM tokens WHERE factory_address IS NULL").all();
  }

  /** Sets a token's origin factory, determined retroactively (e.g. by the backfill
   * script probing each known factory's graduationStatus() until one succeeds). */
  setFactoryAddress(address: string, factoryAddress: string): void {
    this.db
      .prepare("UPDATE tokens SET factory_address = ? WHERE address = ?")
      .run(normalizeAddress(factoryAddress), normalizeAddress(address));
  }

  /** Trackable (non-'unindexed') tokens that haven't graduated yet and have a known
   * origin factory, i.e. candidates for the graduation-status recheck sweep. Once
   * graduated=1 a token is never queried again, since graduation is permanent. */
  listUngraduatedTrackable(limit: number): TokenRow[] {
    // Bounded and round-robin (least-recently-checked first, via graduation_checked_at,
    // which the sweep stamps on every token it reads). Unbounded, this walked ~20k
    // ungraduated Pons coins through ~67 multicall batches against the public RPC every
    // cycle — about 20 minutes — which quietly turned the 5-minute poll interval into a
    // 25-minute one. Graduation is a one-time threshold crossing and the fast sweep
    // already covers young tokens where minutes matter, so a full pass spread across ~13
    // cycles loses nothing.
    return this.db
      .prepare<
        [number],
        TokenRow
      >(
        `SELECT * FROM tokens WHERE graduated = 0 AND status != 'unindexed' AND factory_address IS NOT NULL
         ORDER BY COALESCE(graduation_checked_at, 0) ASC
         LIMIT ?`
      )
      .all(limit);
  }

  /** Like listUngraduatedTrackable, but for the fast sweep: INCLUDES 'unindexed' tokens
   * (the core gap this fixes — brand-new bonding-curve tokens have no DexScreener pair
   * yet, so they're always inserted 'unindexed', and previously got zero graduation
   * tracking until promoted) and bounds the result to tokens launched since `cutoffTs`,
   * so query/RPC cost stays constant regardless of total historical token count. */
  listUngraduatedRecentlyLaunched(cutoffTs: number, limit: number): TokenRow[] {
    // Newest first, hard-capped. The time window alone stopped bounding this once the
    // unindexed sweep began promoting coins in bulk: the window holds thousands, and the
    // 20-second fast cycle stretched to 79-91 seconds working through them. Youngest coins
    // are exactly what a fast lane is for; anything that ages past the cap is still covered
    // by the slow cycle's market scan.
    return this.db
      .prepare<
        [number, number],
        TokenRow
      >(
        `SELECT * FROM tokens WHERE graduated = 0 AND factory_address IS NOT NULL AND first_seen_at >= ?
         ORDER BY first_seen_at DESC LIMIT ?`
      )
      .all(cutoffTs, limit);
  }

  /**
   * Recently-launched tokens that did NOT come from the Pons launchpad (no factory
   * address) — i.e. coins launched straight onto a DEX. They're invisible to the
   * Pons-only graduation/tier sweeps, which is how a token could climb from its launch
   * floor to five figures without ever triggering a market-cap tier alert.
   */
  listNonPonsRecentlyLaunched(cutoffTs: number): TokenRow[] {
    return this.db
      .prepare<
        [number],
        TokenRow
      >("SELECT * FROM tokens WHERE factory_address IS NULL AND status != 'unindexed' AND first_seen_at >= ?")
      .all(cutoffTs);
  }

  /** Recently-launched tokens with live DexScreener data (i.e. not 'unindexed') that
   * haven't hit the momentum re-alert cap yet (0 = never alerted, 1 = alerted once and
   * eligible for one bounded re-alert) — candidates for the fast momentum sweep. */
  listRecentlyLaunchedActive(cutoffTs: number, limit: number): TokenRow[] {
    // Bounded for the same reason as listUngraduatedRecentlyLaunched above.
    return this.db
      .prepare<
        [number, number],
        TokenRow
      >(
        `SELECT * FROM tokens WHERE status != 'unindexed' AND momentum_alert_count < 2 AND first_seen_at >= ?
         ORDER BY first_seen_at DESC LIMIT ?`
      )
      .all(cutoffTs, limit);
  }

  /** Records the highest USD-raised alert tier crossed so far — never re-fires for an
   * already-crossed tier since the fast sweep only alerts on tiers above this value. */
  setGraduationAlertTier(address: string, tier: number): void {
    this.db
      .prepare("UPDATE tokens SET graduation_alert_tier = ? WHERE address = ?")
      .run(tier, normalizeAddress(address));
  }

  /** Bumps the momentum alert count (capped at 2 by the caller via listRecentlyLaunchedActive's
   * filter): 0 -> 1 on the original one-shot alert, 1 -> 2 on the single bounded re-alert. */
  incrementMomentumAlertCount(address: string): void {
    this.db
      .prepare("UPDATE tokens SET momentum_alert_count = momentum_alert_count + 1, momentum_alert_sent = 1 WHERE address = ?")
      .run(normalizeAddress(address));
  }

  /** Persists the pool/pair-token addresses for a token discovered before this field was
   * captured (backfill), or when they weren't available at initial insertIfNew time. */
  setPoolInfo(address: string, poolAddress: string, pairTokenAddress: string): void {
    this.db
      .prepare("UPDATE tokens SET pool_address = ?, pair_token_address = ? WHERE address = ?")
      .run(normalizeAddress(poolAddress), normalizeAddress(pairTokenAddress), normalizeAddress(address));
  }

  /** Caches a token's ERC20 decimals()/totalSupply() after the first successful on-chain
   * read — these never change for a given token, so this is only ever written once. */
  setTokenDecimalsAndSupply(address: string, decimals: number, totalSupply: string): void {
    this.db
      .prepare("UPDATE tokens SET token_decimals = ?, token_total_supply = ? WHERE address = ?")
      .run(decimals, totalSupply, normalizeAddress(address));
  }

  /** Caches just the totalSupply when it was resolved on its own (decimals unknown) —
   * e.g. by the holder-concentration fallback read. Never overwrites an existing value. */
  setTokenTotalSupplyIfMissing(address: string, totalSupply: string): void {
    this.db
      .prepare("UPDATE tokens SET token_total_supply = ? WHERE address = ? AND token_total_supply IS NULL")
      .run(totalSupply, normalizeAddress(address));
  }

  /** Tracks consecutive cycles where a tracked token returned no market data. */
  setNoMarketDataStreak(address: string, streak: number): void {
    this.db
      .prepare("UPDATE tokens SET not_indexed_streak = ? WHERE address = ?")
      .run(streak, normalizeAddress(address));
  }

  /**
   * Demotes an 'active' token that has gone quiet on DexScreener back to 'unindexed'.
   *
   * The active set silently accumulates tokens that were indexed once and never again —
   * measured at 80% of the set, which meant most of every cycle's request budget was spent
   * on coins DexScreener no longer returns, stretching a full rotation to ~25 hours and
   * starving the signals that need fresh data. Demoted tokens aren't forgotten: the
   * unindexed sweep keeps rechecking them and promotes any that come back.
   */
  demoteToUnindexed(address: string, now: number): void {
    this.db
      .prepare("UPDATE tokens SET status = 'unindexed', status_changed_at = ?, last_checked_at = ? WHERE address = ? AND status = 'active'")
      .run(now, now, normalizeAddress(address));
  }

  /** Stamps the breakout cooldown for this token. */
  setBreakoutAlertedAt(address: string, now: number): void {
    this.db
      .prepare("UPDATE tokens SET breakout_alerted_at = ? WHERE address = ?")
      .run(now, normalizeAddress(address));
  }

  /** Records the most recent entry-gate skip reason, so the missed-winners audit can show
   * why a coin that later did well was never alerted. */
  setLastBlockReason(address: string, reason: string, now: number): void {
    this.db
      .prepare("UPDATE tokens SET last_block_reason = ?, last_block_at = ? WHERE address = ?")
      .run(reason, now, normalizeAddress(address));
  }

  /** Tokens that reached a high ATH without ever receiving any entry alert — candidates
   * for the observer's missed-winners audit. */
  listUnalertedHighAth(minAthUsd: number): TokenRow[] {
    return this.db
      .prepare<[number], TokenRow>(
        `SELECT * FROM tokens
         WHERE ath_market_cap_usd >= ?
           AND last_alert_at IS NULL
           AND graduation_alert_tier = 0
           AND momentum_alert_count = 0
           AND first_alert_market_cap_usd IS NULL`
      )
      .all(minAthUsd);
  }

  /** Caches a token's image URL the first time it's observed from DexScreener — never
   * overwrites an already-cached value (the image doesn't change) and never writes null,
   * so callers can pass through a possibly-null value unconditionally. */
  setImageUrlIfMissing(address: string, imageUrl: string): void {
    this.db
      .prepare("UPDATE tokens SET image_url = ? WHERE address = ? AND image_url IS NULL")
      .run(imageUrl, normalizeAddress(address));
  }

  /** Updates the all-time-high market cap only if the new value is higher than the
   * currently stored one (or none is stored yet) — never decreases. */
  updateAthMarketCap(address: string, marketCapUsd: number): void {
    this.db
      .prepare(
        "UPDATE tokens SET ath_market_cap_usd = ? WHERE address = ? AND (ath_market_cap_usd IS NULL OR ath_market_cap_usd < ?)"
      )
      .run(marketCapUsd, normalizeAddress(address), marketCapUsd);
  }

  /** Token has now crossed the graduation threshold — permanent, never rechecked again. */
  markGraduated(address: string, pairedWei: string, thresholdWei: string, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET graduated = 1, graduation_paired_wei = ?,
          graduation_threshold_wei = ?, graduation_checked_at = ?
         WHERE address = ?`
      )
      .run(pairedWei, thresholdWei, now, normalizeAddress(address));
  }

  /** Still ungraduated — refresh the progress figures and checked timestamp for display. */
  updateGraduationProgress(address: string, pairedWei: string, thresholdWei: string, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET graduation_paired_wei = ?, graduation_threshold_wei = ?, graduation_checked_at = ?
         WHERE address = ?`
      )
      .run(pairedWei, thresholdWei, now, normalizeAddress(address));
  }

  /** Sets the entry market-cap baseline for post-alert performance tracking, but only if
   * one isn't already set — this is meant to fire exactly once per token, whether at the
   * moment of its first real alert or (for tokens alerted before this feature existed) the
   * first time this backfill path runs for it. */
  setFirstAlertMarketCap(address: string, marketCapUsd: number, now: number): void {
    this.db
      .prepare(
        `UPDATE tokens SET first_alert_market_cap_usd = ?, first_alert_at = ?
         WHERE address = ? AND first_alert_market_cap_usd IS NULL`
      )
      .run(marketCapUsd, now, normalizeAddress(address));
  }

  /** Updates the peak multiple-since-alert only if the new value is higher than the
   * currently stored one — never decreases, mirrors updateAthMarketCap. */
  updatePeakMultiple(address: string, multiple: number, now: number): void {
    this.db
      .prepare("UPDATE tokens SET peak_multiple = ?, peak_multiple_at = ? WHERE address = ? AND peak_multiple < ?")
      .run(multiple, now, normalizeAddress(address), multiple);
  }

  /** Records the highest performance-milestone multiple crossed so far — never re-fires
   * for an already-crossed milestone, mirrors setGraduationAlertTier. */
  setLastMilestoneMultipleAlerted(address: string, multiple: number): void {
    this.db
      .prepare("UPDATE tokens SET last_milestone_multiple_alerted = ? WHERE address = ?")
      .run(multiple, normalizeAddress(address));
  }

  /** Top tokens by peak multiple since their first alert, for the /performance leaderboard.
   * Only includes tokens that actually have a baseline (peak_multiple > 0 implies one). */
  listTopByPeakMultiple(limit: number): TokenRow[] {
    return this.db
      .prepare<[number], TokenRow>("SELECT * FROM tokens WHERE peak_multiple > 0 ORDER BY peak_multiple DESC LIMIT ?")
      .all(limit);
  }

  countByGraduation(): { graduated: number; ungraduated: number } {
    const row = this.db
      .prepare<
        [],
        { graduated: number; ungraduated: number }
      >("SELECT SUM(graduated) as graduated, COUNT(*) - SUM(graduated) as ungraduated FROM tokens")
      .get();
    return { graduated: row?.graduated ?? 0, ungraduated: row?.ungraduated ?? 0 };
  }

  /** Paginated, filterable token search for the Mini App API. Builds a single parameterized
   * WHERE clause and reuses it for both the page query and the total count. */
  search(opts: {
    status?: TokenStatus;
    revivingOnly?: boolean;
    graduated?: boolean;
    search?: string;
    sort?: "symbol" | "status_changed_at";
    limit: number;
    offset: number;
  }): { rows: TokenRow[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts.revivingOnly) {
      conditions.push("revival_confirm_count > 0");
    }
    if (opts.graduated !== undefined) {
      conditions.push("graduated = ?");
      params.push(opts.graduated ? 1 : 0);
    }
    if (opts.search) {
      conditions.push("(symbol LIKE ? OR address LIKE ?)");
      const like = `%${opts.search}%`;
      params.push(like, `%${opts.search.toLowerCase()}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortColumn = opts.sort === "symbol" ? "symbol" : "status_changed_at";

    const rows = this.db
      .prepare<
        (string | number)[],
        TokenRow
      >(`SELECT * FROM tokens ${where} ORDER BY ${sortColumn} ASC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset);

    const totalRow = this.db
      .prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) as count FROM tokens ${where}`)
      .get(...params);

    return { rows, total: totalRow?.count ?? 0 };
  }
}
