import type { Db } from "./db.js";
import { normalizeAddress } from "./chains.js";

/** One row per coin that received a real (non-dry-run) entry alert: the entry features
 * known at alert time, market-cap checkpoints observed 1h/6h/24h later, and the derived
 * outcome. Checkpoint value 0 means DexScreener no longer returned any pair (liquidity
 * pulled / delisted) — a real observation; NULL means not yet checked. */
export interface AlertOutcomeRow {
  address: string;
  first_alerted_at: number;
  alert_type: string;
  entry_market_cap_usd: number | null;
  bundle_top5_pct: number | null;
  holder_top10_pct: number | null;
  dev_sold: number | null;
  had_website: number;
  social_count: number;
  mcap_1h_usd: number | null;
  mcap_6h_usd: number | null;
  mcap_24h_usd: number | null;
  outcome: string;
  outcome_updated_at: number | null;
  chain: string | null;
  age_minutes_at_alert: number | null;
  conviction: string | null;
  /** 1 once the one-time dump/rug warning has been sent for this coin. */
  warning_sent: number;
}

export interface MissedWinnerRow {
  address: string;
  symbol: string;
  detected_at: number;
  ath_market_cap_usd: number;
  block_reason: string | null;
}

/** Per-outcome aggregate of the entry features, the raw material for /insights'
 * winners-vs-dumpers pattern comparison. Every figure is an aggregate of real recorded
 * values — rows with a NULL feature are simply excluded from that feature's average. */
export interface OutcomeFeatureStats {
  outcome: string;
  count: number;
  avgBundleTop5Pct: number | null;
  avgHolderTop10Pct: number | null;
  devSoldRate: number | null;
  avgSocialCount: number | null;
}

export class OutcomeRepo {
  constructor(private readonly db: Db) {}

  /** Records the entry snapshot for a coin's FIRST real alert. INSERT OR IGNORE — later
   * alerts for the same coin never overwrite the original entry features. */
  recordEntry(entry: {
    address: string;
    firstAlertedAt: number;
    alertType: string;
    entryMarketCapUsd: number | null;
    bundleTop5Pct: number | null;
    holderTop10Pct: number | null;
    devSold: number | null;
    hadWebsite: boolean;
    socialCount: number;
    chain?: string | null;
    ageMinutesAtAlert?: number | null;
    conviction?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO alert_outcomes
          (address, first_alerted_at, alert_type, entry_market_cap_usd, bundle_top5_pct,
           holder_top10_pct, dev_sold, had_website, social_count, chain, age_minutes_at_alert, conviction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizeAddress(entry.address),
        entry.firstAlertedAt,
        entry.alertType,
        entry.entryMarketCapUsd,
        entry.bundleTop5Pct,
        entry.holderTop10Pct,
        entry.devSold,
        entry.hadWebsite ? 1 : 0,
        entry.socialCount,
        entry.chain ?? null,
        entry.ageMinutesAtAlert ?? null,
        entry.conviction ?? null
      );
  }

  /** Rows with at least one unfilled checkpoint whose time has elapsed. Bounded to alerts
   * from the last `maxAgeMs` so a permanently-unresolvable row can't be retried forever. */
  listDueForCheckpoints(now: number, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): AlertOutcomeRow[] {
    const h1 = now - 60 * 60 * 1000;
    const h6 = now - 6 * 60 * 60 * 1000;
    const h24 = now - 24 * 60 * 60 * 1000;
    return this.db
      .prepare<
        [number, number, number, number],
        AlertOutcomeRow
      >(
        `SELECT * FROM alert_outcomes
         WHERE first_alerted_at >= ?
           AND (
             (mcap_1h_usd IS NULL AND first_alerted_at <= ?)
             OR (mcap_6h_usd IS NULL AND first_alerted_at <= ?)
             OR (mcap_24h_usd IS NULL AND first_alerted_at <= ?)
           )`
      )
      .all(now - maxAgeMs, h1, h6, h24);
  }

  /** Fills whichever checkpoints were resolved this pass and stores the (re)derived
   * outcome. Checkpoint fields left undefined are untouched. */
  applyCheckpoints(
    address: string,
    checkpoints: { mcap1hUsd?: number; mcap6hUsd?: number; mcap24hUsd?: number },
    outcome: string,
    now: number
  ): void {
    const sets: string[] = ["outcome = ?", "outcome_updated_at = ?"];
    const params: (string | number)[] = [outcome, now];
    if (checkpoints.mcap1hUsd !== undefined) {
      sets.push("mcap_1h_usd = ?");
      params.push(checkpoints.mcap1hUsd);
    }
    if (checkpoints.mcap6hUsd !== undefined) {
      sets.push("mcap_6h_usd = ?");
      params.push(checkpoints.mcap6hUsd);
    }
    if (checkpoints.mcap24hUsd !== undefined) {
      sets.push("mcap_24h_usd = ?");
      params.push(checkpoints.mcap24hUsd);
    }
    params.push(normalizeAddress(address));
    this.db.prepare(`UPDATE alert_outcomes SET ${sets.join(", ")} WHERE address = ?`).run(...params);
  }

  /** Marks the one-time dump/rug warning as sent so it can never re-fire. */
  markWarningSent(address: string): void {
    this.db.prepare("UPDATE alert_outcomes SET warning_sent = 1 WHERE address = ?").run(normalizeAddress(address));
  }

  findByAddress(address: string): AlertOutcomeRow | undefined {
    return this.db
      .prepare<[string], AlertOutcomeRow>("SELECT * FROM alert_outcomes WHERE address = ?")
      .get(normalizeAddress(address));
  }

  countByOutcome(): Record<string, number> {
    const rows = this.db
      .prepare<[], { outcome: string; c: number }>("SELECT outcome, COUNT(*) c FROM alert_outcomes GROUP BY outcome")
      .all();
    const result: Record<string, number> = {};
    for (const row of rows) result[row.outcome] = row.c;
    return result;
  }

  /** Per-outcome averages of the recorded entry features — the winners-vs-dumpers
   * pattern data behind /insights. */
  featureStatsByOutcome(): OutcomeFeatureStats[] {
    return this.db
      .prepare<
        [],
        {
          outcome: string;
          count: number;
          avgBundleTop5Pct: number | null;
          avgHolderTop10Pct: number | null;
          devSoldRate: number | null;
          avgSocialCount: number | null;
        }
      >(
        `SELECT outcome,
                COUNT(*) as count,
                AVG(bundle_top5_pct) as avgBundleTop5Pct,
                AVG(holder_top10_pct) as avgHolderTop10Pct,
                AVG(dev_sold) as devSoldRate,
                AVG(social_count) as avgSocialCount
         FROM alert_outcomes GROUP BY outcome`
      )
      .all();
  }

  /** Every resolved alert's bundle reading paired with its outcome, so a proposed cap can
   * be replayed against real history before it is ever applied. */
  resolvedBundleOutcomes(): { bundlePct: number; outcome: string }[] {
    return this.db
      .prepare<[], { bundlePct: number; outcome: string }>(
        `SELECT bundle_top5_pct as bundlePct, outcome FROM alert_outcomes
         WHERE bundle_top5_pct IS NOT NULL AND outcome IN ('winner', 'dumper')`
      )
      .all();
  }

  /** Resolved win/dump/flat counts per conviction rating — the scoreboard that shows
   * whether the measured buckets still hold as fresh data arrives. */
  outcomeCountsByConviction(): { conviction: string; winners: number; dumpers: number; flat: number }[] {
    return this.db
      .prepare<[], { conviction: string; winners: number; dumpers: number; flat: number }>(
        `SELECT COALESCE(conviction, 'unrated') as conviction,
                SUM(outcome = 'winner') as winners,
                SUM(outcome = 'dumper') as dumpers,
                SUM(outcome = 'flat') as flat
         FROM alert_outcomes WHERE outcome != 'pending'
         GROUP BY COALESCE(conviction, 'unrated')`
      )
      .all();
  }

  /**
   * The honest scoreboard, measured purely from recorded checkpoints rather than the peak.
   *
   * `outcome = 'winner'` only means the coin *touched* 2x at some instant, and the label is
   * sticky — a coin that spiked 2x for one minute and then went to zero stays a "winner"
   * forever. That is why the headline win rate reads near 100% and means far less than it
   * appears to. These figures instead ask what the coin was actually worth at each
   * checkpoint, which is what a holder would have experienced.
   *
   * 1h is the horizon that matters most: these coins are traded in minutes, not held for a
   * day, so the 24h column mostly measures how far the average memecoin has decayed rather
   * than whether the alert was any good.
   */
  checkpointScoreboard(): { horizon: string; total: number; doubled: number; up: number; halved: number }[] {
    const horizons: { horizon: string; column: string }[] = [
      { horizon: "1h", column: "mcap_1h_usd" },
      { horizon: "6h", column: "mcap_6h_usd" },
      { horizon: "24h", column: "mcap_24h_usd" },
    ];
    return horizons.map(({ horizon, column }) => {
      const row = this.db
        .prepare<[], { total: number; doubled: number; up: number; halved: number }>(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN ${column} >= entry_market_cap_usd * 2 THEN 1 ELSE 0 END) as doubled,
                  SUM(CASE WHEN ${column} > entry_market_cap_usd THEN 1 ELSE 0 END) as up,
                  SUM(CASE WHEN ${column} <= entry_market_cap_usd * 0.5 THEN 1 ELSE 0 END) as halved
           FROM alert_outcomes
           WHERE ${column} IS NOT NULL AND entry_market_cap_usd IS NOT NULL AND entry_market_cap_usd > 0`
        )
        .get();
      return { horizon, total: row?.total ?? 0, doubled: row?.doubled ?? 0, up: row?.up ?? 0, halved: row?.halved ?? 0 };
    });
  }

  /** Share of each conviction bucket that was worth more 1h after the alert — the check on
   * whether the conviction gate is actually separating good calls from noise. */
  oneHourUpRateByConviction(): { conviction: string; total: number; up: number }[] {
    return this.db
      .prepare<[], { conviction: string; total: number; up: number }>(
        `SELECT COALESCE(conviction, 'unrated') as conviction,
                COUNT(*) as total,
                SUM(CASE WHEN mcap_1h_usd > entry_market_cap_usd THEN 1 ELSE 0 END) as up
         FROM alert_outcomes
         WHERE mcap_1h_usd IS NOT NULL AND entry_market_cap_usd IS NOT NULL AND entry_market_cap_usd > 0
         GROUP BY COALESCE(conviction, 'unrated')`
      )
      .all();
  }

  /** Resolved win/dump/flat counts per alert type — shows which of the bot's signals is
   * actually worth trusting. Pending rows are excluded, since their fate isn't known. */
  outcomeCountsByAlertType(): { alertType: string; winners: number; dumpers: number; flat: number }[] {
    return this.db
      .prepare<[], { alertType: string; winners: number; dumpers: number; flat: number }>(
        `SELECT alert_type as alertType,
                SUM(outcome = 'winner') as winners,
                SUM(outcome = 'dumper') as dumpers,
                SUM(outcome = 'flat') as flat
         FROM alert_outcomes WHERE outcome != 'pending'
         GROUP BY alert_type ORDER BY winners DESC`
      )
      .all();
  }

  /** Records (or raises the ATH of) a coin that did well without ever being alerted. The
   * first detected_at is kept; ath only ever increases; a newly-known block reason wins
   * over an unknown one. */
  upsertMissedWinner(address: string, symbol: string, detectedAt: number, athMarketCapUsd: number, blockReason: string | null): void {
    this.db
      .prepare(
        `INSERT INTO missed_winners (address, symbol, detected_at, ath_market_cap_usd, block_reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           ath_market_cap_usd = MAX(ath_market_cap_usd, excluded.ath_market_cap_usd),
           symbol = excluded.symbol,
           block_reason = COALESCE(excluded.block_reason, block_reason)`
      )
      .run(normalizeAddress(address), symbol, detectedAt, athMarketCapUsd, blockReason);
  }

  listMissedWinners(limit: number): MissedWinnerRow[] {
    return this.db
      .prepare<[number], MissedWinnerRow>("SELECT * FROM missed_winners ORDER BY ath_market_cap_usd DESC LIMIT ?")
      .all(limit);
  }

  countMissedWinners(): number {
    const row = this.db.prepare<[], { c: number }>("SELECT COUNT(*) c FROM missed_winners").get();
    return row?.c ?? 0;
  }
}
