import type { Db } from "./db.js";
import type { MarketSnapshot, WatchRow } from "../types/domain.js";

export class WatchRepo {
  constructor(private readonly db: Db) {}

  findByChatAndToken(chatId: number, tokenId: number): WatchRow | undefined {
    return this.db
      .prepare<[number, number], WatchRow>("SELECT * FROM watches WHERE chat_id = ? AND token_id = ?")
      .get(chatId, tokenId);
  }

  findById(id: number): WatchRow | undefined {
    return this.db.prepare<[number], WatchRow>("SELECT * FROM watches WHERE id = ?").get(id);
  }

  getOrCreate(chatId: number, tokenId: number, market: MarketSnapshot): WatchRow {
    const existing = this.findByChatAndToken(chatId, tokenId);
    if (existing) return existing;

    const result = this.db
      .prepare(
        `INSERT INTO watches (chat_id, token_id, added_at, initial_price_usd, initial_mcap, initial_liquidity_usd)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chatId, tokenId, Date.now(), market.priceUsd, market.mcap, market.liquidityUsd);

    return this.findById(Number(result.lastInsertRowid))!;
  }

  listForChat(chatId: number): WatchRow[] {
    return this.db
      .prepare<[number], WatchRow>("SELECT * FROM watches WHERE chat_id = ? ORDER BY added_at DESC")
      .all(chatId);
  }

  listForToken(tokenId: number): WatchRow[] {
    return this.db.prepare<[number], WatchRow>("SELECT * FROM watches WHERE token_id = ?").all(tokenId);
  }

  remove(watchId: number): void {
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(watchId);
  }

  countRules(watchId: number): number {
    const row = this.db
      .prepare<[number], { c: number }>("SELECT COUNT(*) as c FROM rules WHERE watch_id = ? AND active = 1")
      .get(watchId);
    return row?.c ?? 0;
  }
}
