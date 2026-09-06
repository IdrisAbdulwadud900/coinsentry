import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  status_changed_at INTEGER NOT NULL,
  last_alert_at INTEGER,
  dead_confirm_count INTEGER NOT NULL DEFAULT 0,
  revival_confirm_count INTEGER NOT NULL DEFAULT 0,
  demote_confirm_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  volume_5m REAL,
  volume_1h REAL,
  volume_24h REAL,
  txns_buys_5m INTEGER,
  txns_buys_1h INTEGER,
  liquidity_usd REAL,
  price_usd REAL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_address_ts ON snapshots(address, ts);

CREATE TABLE IF NOT EXISTS discovery_state (
  factory_address TEXT PRIMARY KEY,
  last_scanned_block TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  dry_run INTEGER NOT NULL,
  volume_1h REAL,
  buys_1h INTEGER,
  liquidity_usd REAL,
  price_usd REAL,
  baseline_median_volume_1h REAL,
  baseline_median_liquidity_usd REAL,
  dead_for_hours REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Observer: one row per coin that received a real entry alert, capturing the entry
-- features known at alert time plus post-alert market-cap checkpoints, so the bot can
-- learn which entry patterns separate winners from dumpers (see /insights).
CREATE TABLE IF NOT EXISTS alert_outcomes (
  address TEXT PRIMARY KEY REFERENCES tokens(address) ON DELETE CASCADE,
  first_alerted_at INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  entry_market_cap_usd REAL,
  bundle_top5_pct REAL,
  holder_top10_pct REAL,
  dev_sold INTEGER,
  had_website INTEGER NOT NULL DEFAULT 0,
  social_count INTEGER NOT NULL DEFAULT 0,
  -- Market cap observed ~1h/6h/24h after the alert. 0 means DexScreener no longer
  -- returned any pair at that checkpoint (liquidity pulled / delisted) — a real
  -- observation, not a fabricated figure. NULL means not yet checked.
  mcap_1h_usd REAL,
  mcap_6h_usd REAL,
  mcap_24h_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_updated_at INTEGER,
  -- One-time dump/rug warning flag: set once the owner has been warned that this alerted
  -- coin's pair vanished or its market cap crashed below the warning floor.
  warning_sent INTEGER NOT NULL DEFAULT 0
);

-- Observer: coins that reached a high ATH without ever receiving an alert, recorded so
-- the owner can see what the gates cost and why (block_reason is the last gate skip).
CREATE TABLE IF NOT EXISTS missed_winners (
  address TEXT PRIMARY KEY REFERENCES tokens(address) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  ath_market_cap_usd REAL NOT NULL,
  block_reason TEXT
);
`;

/** Adds columns/index introduced after the initial release. Safe to run repeatedly
 * against an already-migrated DB — each ALTER is guarded by checking pragma_table_info. */
function migrate(db: Database.Database): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('tokens')").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("deployer_address")) {
    db.exec("ALTER TABLE tokens ADD COLUMN deployer_address TEXT");
  }
  if (!columnNames.has("not_indexed_streak")) {
    db.exec("ALTER TABLE tokens ADD COLUMN not_indexed_streak INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("last_checked_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_checked_at INTEGER");
  }
  if (!columnNames.has("factory_address")) {
    db.exec("ALTER TABLE tokens ADD COLUMN factory_address TEXT");
  }
  if (!columnNames.has("graduated")) {
    db.exec("ALTER TABLE tokens ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("graduation_paired_wei")) {
    db.exec("ALTER TABLE tokens ADD COLUMN graduation_paired_wei TEXT");
  }
  if (!columnNames.has("graduation_threshold_wei")) {
    db.exec("ALTER TABLE tokens ADD COLUMN graduation_threshold_wei TEXT");
  }
  if (!columnNames.has("graduation_checked_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN graduation_checked_at INTEGER");
  }
  if (!columnNames.has("graduation_alert_tier")) {
    db.exec("ALTER TABLE tokens ADD COLUMN graduation_alert_tier INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("momentum_alert_sent")) {
    db.exec("ALTER TABLE tokens ADD COLUMN momentum_alert_sent INTEGER NOT NULL DEFAULT 0");
  }
  // Superseded by momentum_alert_count below (0/1/2, allows one bounded re-alert), but
  // the old momentum_alert_sent column is left in place rather than dropped, since
  // SQLite can't drop columns cheaply and no data loss matters here for a signal-only bot.
  if (!columnNames.has("momentum_alert_count")) {
    db.exec("ALTER TABLE tokens ADD COLUMN momentum_alert_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("pool_address")) {
    db.exec("ALTER TABLE tokens ADD COLUMN pool_address TEXT");
  }
  if (!columnNames.has("pair_token_address")) {
    db.exec("ALTER TABLE tokens ADD COLUMN pair_token_address TEXT");
  }
  if (!columnNames.has("token_decimals")) {
    db.exec("ALTER TABLE tokens ADD COLUMN token_decimals INTEGER");
  }
  if (!columnNames.has("token_total_supply")) {
    db.exec("ALTER TABLE tokens ADD COLUMN token_total_supply TEXT");
  }
  if (!columnNames.has("ath_market_cap_usd")) {
    db.exec("ALTER TABLE tokens ADD COLUMN ath_market_cap_usd REAL");
  }
  // Performance tracking ("how many x's since alert"): first_alert_market_cap_usd is the
  // entry baseline (set once, guarded), peak_multiple is the highest current/entry ratio
  // observed since that baseline was set, and last_milestone_multiple_alerted guards the
  // milestone-alert ladder the same way graduation_alert_tier guards market-cap tiers.
  if (!columnNames.has("first_alert_market_cap_usd")) {
    db.exec("ALTER TABLE tokens ADD COLUMN first_alert_market_cap_usd REAL");
  }
  if (!columnNames.has("first_alert_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN first_alert_at INTEGER");
  }
  if (!columnNames.has("peak_multiple")) {
    db.exec("ALTER TABLE tokens ADD COLUMN peak_multiple REAL NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("peak_multiple_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN peak_multiple_at INTEGER");
  }
  if (!columnNames.has("last_milestone_multiple_alerted")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_milestone_multiple_alerted REAL NOT NULL DEFAULT 0");
  }
  // Caches the DexScreener image URL once known, so alert paths that never call
  // DexScreener themselves (e.g. the pure-on-chain fast graduation sweep) can still show
  // a real, previously-seen image instead of none at all.
  if (!columnNames.has("image_url")) {
    db.exec("ALTER TABLE tokens ADD COLUMN image_url TEXT");
  }
  // Block number the token's TokenLaunched event was emitted in, captured at discovery
  // time (mirrors the existing *_wei string-for-bigint pattern). Null for legacy rows
  // discovered before this field was captured — used to bound the early-buy-concentration
  // getLogs window, never backfilled.
  if (!columnNames.has("launch_block")) {
    db.exec("ALTER TABLE tokens ADD COLUMN launch_block TEXT");
  }
  // Most recent entry-gate skip reason for this token (e.g. "no website or social links"),
  // recorded so the missed-winners audit can show WHY a coin that later did well was
  // never alerted. Null for tokens never blocked.
  if (!columnNames.has("last_block_reason")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_block_reason TEXT");
  }
  // Timestamp this token last went through the main cycle's DexScreener market-data
  // lookup. Drives the round-robin scan that keeps each cycle inside its interval
  // (see listTrackableForCycle) — oldest-checked tokens are always served first, so
  // nothing starves regardless of how large the token table grows.
  if (!columnNames.has("market_checked_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN market_checked_at INTEGER");
  }
  // DexScreener chainId slug this token lives on. Every pre-existing row predates
  // multi-chain support and is therefore Robinhood, which the default backfills.
  // When the entry gate last blocked this token, used to throttle how often a blocked
  // token re-runs the gate's DexScreener lookup (see GATE_RECHECK_INTERVAL_MS).
  if (!columnNames.has("last_block_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_block_at INTEGER");
  }
  // Dedicated cooldown for the breakout signal, kept separate from last_alert_at so a
  // breakout can't suppress the revival/demotion logic that also reads that field.
  if (!columnNames.has("breakout_alerted_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN breakout_alerted_at INTEGER");
  }
  if (!columnNames.has("chain")) {
    db.exec("ALTER TABLE tokens ADD COLUMN chain TEXT NOT NULL DEFAULT 'robinhood'");
  }
  // When the coin was last seen actually trading. Lets the market scan put live coins at
  // the front without correlating a subquery against the multi-million-row snapshots table
  // for every token on every cycle, which was heavy enough to kill the process outright.
  // Maps a swap log's pool back to its token (see listByPairAddresses). Without this the
  // lookup is a full scan of the token table on every swap-activity pass.
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_pair_address ON tokens(pair_address)");
  if (!columnNames.has("last_traded_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_traded_at INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_last_traded_at ON tokens(last_traded_at)");
  }

  // alert_outcomes existed for one release without warning_sent; add it for those DBs.
  const outcomeColumns = db.prepare("SELECT name FROM pragma_table_info('alert_outcomes')").all() as { name: string }[];
  const outcomeNames = new Set(outcomeColumns.map((c) => c.name));
  if (!outcomeNames.has("warning_sent")) {
    db.exec("ALTER TABLE alert_outcomes ADD COLUMN warning_sent INTEGER NOT NULL DEFAULT 0");
  }
  // Chain and age-at-alert turned out to be the only features that actually separate
  // winners from dumpers (measured 2026-08-04: Robinhood alerted <5 min after launch wins
  // 82% of the time; Solana under 30 min wins ~20% and dumps ~55%). Recorded natively so
  // the observer keeps refining those buckets instead of needing a manual join.
  if (!outcomeNames.has("chain")) {
    db.exec("ALTER TABLE alert_outcomes ADD COLUMN chain TEXT");
  }
  if (!outcomeNames.has("age_minutes_at_alert")) {
    db.exec("ALTER TABLE alert_outcomes ADD COLUMN age_minutes_at_alert REAL");
  }
  if (!outcomeNames.has("conviction")) {
    db.exec("ALTER TABLE alert_outcomes ADD COLUMN conviction TEXT");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_deployer ON tokens(deployer_address)");
  // Composite index covers listUngraduatedTrackable()'s exact WHERE clause (graduated,
  // status, factory_address in that order), and as a left-prefix also serves any query
  // that filters on graduated alone (e.g. search({ graduated }), countByGraduation) —
  // superseding the old single-column idx_tokens_graduated, which is dropped below.
  db.exec("DROP INDEX IF EXISTS idx_tokens_graduated");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_graduation_sweep ON tokens(graduated, status, factory_address)");
  // Covers both new fast-sweep queries, which filter on first_seen_at recency plus
  // graduated/status (ungraduated sweep) or status/momentum_alert_sent (momentum sweep).
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at ON tokens(first_seen_at)");
  // Serves the /performance leaderboard's ORDER BY peak_multiple DESC.
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_peak_multiple ON tokens(peak_multiple)");
  // Serves listTrackableForCycle's ORDER BY market_checked_at ASC round-robin scan.
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_market_checked ON tokens(market_checked_at)");
  // Serves the per-chain grouping of the market scan and the /status chain breakdown.
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain)");
}

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  cachePreparedStatements(db);
  return db;
}

/**
 * Makes `prepare` memoize on the SQL string.
 *
 * Every repo method compiles its statement fresh on each call — `tokenRepo` alone has 28
 * such sites — so a single market-scan cycle over 1,500 tokens compiled on the order of
 * 15,000 statements. Each one wraps a native sqlite3_stmt whose memory V8 does not account
 * for, so the heap filled with objects the collector had no urgency to finalise: GC logs
 * showed Mark-Compact reclaiming nothing (511.4 -> 511.2 MB) and the process died on the
 * heap limit every few minutes. The per-token cost measured ~320KB, which is the shape of
 * a compiled statement, not of the row data.
 *
 * Safe because nothing in this codebase calls `.iterate()`: a cached statement is only ever
 * re-entered by `.run()`, `.get()` and `.all()`, which reset it on each call. SQLite also
 * prefers reused statements — this is the library's documented recommendation, not a trick.
 */
function cachePreparedStatements(db: Database.Database): void {
  const cache = new Map<string, Database.Statement>();
  const compile = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    let statement = cache.get(sql);
    if (statement === undefined) {
      statement = compile(sql);
      cache.set(sql, statement);
    }
    return statement;
  }) as typeof db.prepare;
}

export type Db = Database.Database;
