import type { Db } from "./db.js";
import type { MarketSnapshot, SnapshotRow } from "../types/domain.js";

const MAX_SNAPSHOTS_PER_TOKEN = 60;

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

  insert(tokenId: number, market: MarketSnapshot, ts: number = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO snapshots
           (token_id, ts, price_usd, mcap, liquidity_usd, volume_m5, volume_h1, volume_h24,
            price_change_m5, price_change_h1, price_change_h6, price_change_h24)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          tokenId,
          ts,
          market.priceUsd,
          market.mcap,
          market.liquidityUsd,
          market.volumeM5,
          market.volumeH1,
          market.volumeH24,
          market.priceChangeM5,
          market.priceChangeH1,
          market.priceChangeH6,
          market.priceChangeH24
        );

      // Prune anything beyond the last MAX_SNAPSHOTS_PER_TOKEN rows for this token.
      this.db
        .prepare(
          `DELETE FROM snapshots WHERE token_id = ? AND id NOT IN (
             SELECT id FROM snapshots WHERE token_id = ? ORDER BY ts DESC LIMIT ?
           )`
        )
        .run(tokenId, tokenId, MAX_SNAPSHOTS_PER_TOKEN);
    });
    tx();
  }

  /** Most recent snapshots for a token, oldest first. */
  recentForToken(tokenId: number, limit: number = MAX_SNAPSHOTS_PER_TOKEN): SnapshotRow[] {
    const rows = this.db
      .prepare<[number, number], SnapshotRow>(
        "SELECT * FROM snapshots WHERE token_id = ? ORDER BY ts DESC LIMIT ?"
      )
      .all(tokenId, limit);
    return rows.reverse();
  }
}
