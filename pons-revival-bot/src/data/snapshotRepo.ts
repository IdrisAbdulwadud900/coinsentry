import type { Db } from "./db.js";
import type { MarketSnapshot, SnapshotRow } from "../types/domain.js";

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

  insert(market: MarketSnapshot, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO snapshots
          (address, ts, volume_5m, volume_1h, volume_24h, txns_buys_5m, txns_buys_1h, liquidity_usd, price_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        market.tokenAddress.toLowerCase(),
        ts,
        market.volume5m,
        market.volume1h,
        market.volume24h,
        market.buys5m,
        market.buys1h,
        market.liquidityUsd,
        market.priceUsd
      );
  }

  /** Returns the most recent snapshots for a token since a given timestamp, oldest first, capped at `limit`. */
  recentSince(address: string, sinceTs: number, limit: number): SnapshotRow[] {
    const rows = this.db
      .prepare<[string, number, number], SnapshotRow>(
        `SELECT * FROM snapshots WHERE address = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
      )
      .all(address.toLowerCase(), sinceTs, limit);
    return rows.reverse();
  }

  latestForToken(address: string): SnapshotRow | undefined {
    return this.db
      .prepare<[string], SnapshotRow>(`SELECT * FROM snapshots WHERE address = ? ORDER BY ts DESC LIMIT 1`)
      .get(address.toLowerCase());
  }

  /** Folds the WAL back into the main database and truncates it to zero.
   *
   * SQLite's automatic checkpointing is passive: it needs a moment with no active reader
   * or writer, which a continuously-polling cycle rarely provides. Left alone the WAL grew
   * to 363MB against a 641MB database and filled the 1GB volume, at which point the file
   * could no longer be opened at all. */
  checkpointWal(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  pruneOlderThan(cutoffTs: number): number {
    const result = this.db.prepare("DELETE FROM snapshots WHERE ts < ?").run(cutoffTs);
    return result.changes;
  }
}
