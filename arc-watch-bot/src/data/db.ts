import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface LaunchRow {
  token_address: string;
  symbol: string | null;
  name: string | null;
  kind: string;
  factory: string;
  pool_address: string;
  quote_address: string;
  deployer: string | null;
  launch_block: string;
  tx_hash: string;
  liquidity_quote: number | null;
  quote_symbol: string | null;
  verified: number | null;
  discovered_at: number;
  alerted_at: number | null;
  skip_reason: string | null;
}

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        token_address TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        kind TEXT NOT NULL,
        factory TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        quote_address TEXT NOT NULL,
        deployer TEXT,
        launch_block TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        liquidity_quote REAL,
        quote_symbol TEXT,
        verified INTEGER,
        discovered_at INTEGER NOT NULL,
        alerted_at INTEGER,
        skip_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_launches_deployer ON launches(deployer);
      CREATE TABLE IF NOT EXISTS cursors (
        scope TEXT PRIMARY KEY,
        last_scanned_block TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getFlag(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM flags WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setFlag(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO flags (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, value, Date.now());
  }

  getCursor(scope: string): bigint | null {
    const row = this.db.prepare("SELECT last_scanned_block FROM cursors WHERE scope = ?").get(scope) as
      | { last_scanned_block: string }
      | undefined;
    return row ? BigInt(row.last_scanned_block) : null;
  }

  setCursor(scope: string, block: bigint): void {
    this.db
      .prepare(
        "INSERT INTO cursors (scope, last_scanned_block) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET last_scanned_block = excluded.last_scanned_block"
      )
      .run(scope, block.toString());
  }

  hasLaunch(tokenAddress: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM launches WHERE token_address = ?").get(tokenAddress.toLowerCase())
    );
  }

  insertLaunch(row: Omit<LaunchRow, "alerted_at">): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO launches
         (token_address, symbol, name, kind, factory, pool_address, quote_address, deployer,
          launch_block, tx_hash, liquidity_quote, quote_symbol, verified, discovered_at, alerted_at, skip_reason)
         VALUES (@token_address, @symbol, @name, @kind, @factory, @pool_address, @quote_address, @deployer,
          @launch_block, @tx_hash, @liquidity_quote, @quote_symbol, @verified, @discovered_at, NULL, @skip_reason)`
      )
      .run(row);
  }

  /**
   * Launches awaiting a quality verdict: inserted, not yet alerted, not yet
   * skipped, and old enough that their observation window has fully elapsed.
   */
  getPendingLaunches(maxLaunchBlock: bigint, limit: number): LaunchRow[] {
    return this.db
      .prepare(
        `SELECT * FROM launches
         WHERE alerted_at IS NULL AND skip_reason IS NULL
           AND CAST(launch_block AS INTEGER) <= ?
         ORDER BY CAST(launch_block AS INTEGER) ASC
         LIMIT ?`
      )
      .all(Number(maxLaunchBlock), limit) as LaunchRow[];
  }

  markSkipped(tokenAddress: string, reason: string): void {
    this.db
      .prepare("UPDATE launches SET skip_reason = ? WHERE token_address = ?")
      .run(reason, tokenAddress.toLowerCase());
  }

  markAlerted(tokenAddress: string): void {
    this.db
      .prepare("UPDATE launches SET alerted_at = ? WHERE token_address = ?")
      .run(Date.now(), tokenAddress.toLowerCase());
  }

  countByDeployer(deployer: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM launches WHERE deployer = ?")
      .get(deployer.toLowerCase()) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
