import type { Db } from "./db.js";
import type { MarketSnapshot, TokenRow } from "../types/domain.js";

export class TokenRepo {
  constructor(private readonly db: Db) {}

  findByChainAndPair(chainId: string, pairAddress: string): TokenRow | undefined {
    return this.db
      .prepare<[string, string], TokenRow>(
        "SELECT * FROM tokens WHERE chain_id = ? AND pair_address = ?"
      )
      .get(chainId, pairAddress);
  }

  findById(id: number): TokenRow | undefined {
    return this.db.prepare<[number], TokenRow>("SELECT * FROM tokens WHERE id = ?").get(id);
  }

  /** Inserts the token if it doesn't exist, or updates its cached identity fields. Returns the row. */
  upsertFromMarket(market: MarketSnapshot): TokenRow {
    const now = Date.now();
    const existing = this.findByChainAndPair(market.chainId, market.pairAddress);

    if (existing) {
      this.db
        .prepare(
          `UPDATE tokens SET dex_id = ?, token_address = ?, symbol = ?, name = ?, pair_url = ?, is_indexed = 1, updated_at = ? WHERE id = ?`
        )
        .run(market.dexId, market.tokenAddress, market.symbol, market.name, market.pairUrl, now, existing.id);
      return this.findById(existing.id)!;
    }

    const result = this.db
      .prepare(
        `INSERT INTO tokens (chain_id, dex_id, pair_address, token_address, symbol, name, pair_url, is_indexed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        market.chainId,
        market.dexId,
        market.pairAddress,
        market.tokenAddress,
        market.symbol,
        market.name,
        market.pairUrl,
        now,
        now
      );

    return this.findById(Number(result.lastInsertRowid))!;
  }

  markIndexed(tokenId: number, isIndexed: boolean): void {
    this.db
      .prepare("UPDATE tokens SET is_indexed = ?, updated_at = ? WHERE id = ?")
      .run(isIndexed ? 1 : 0, Date.now(), tokenId);
  }

  /** All tokens that currently have at least one active watch. */
  listActivelyWatched(): TokenRow[] {
    return this.db
      .prepare<[], TokenRow>(
        `SELECT DISTINCT t.* FROM tokens t
         INNER JOIN watches w ON w.token_id = t.id
         WHERE t.is_indexed = 1`
      )
      .all();
  }
}
