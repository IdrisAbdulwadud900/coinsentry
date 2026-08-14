import type { Db } from "./db.js";
import type { PendingDigestRow } from "../types/domain.js";

export class DigestRepo {
  constructor(private readonly db: Db) {}

  enqueue(chatId: number, messageText: string, replyMarkup?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO pending_digest (chat_id, message_text, reply_markup_json, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(chatId, messageText, replyMarkup ? JSON.stringify(replyMarkup) : null, Date.now());
  }

  listChatsWithPending(): number[] {
    const rows = this.db
      .prepare<[], { chat_id: number }>("SELECT DISTINCT chat_id FROM pending_digest")
      .all();
    return rows.map((r) => r.chat_id);
  }

  takeForChat(chatId: number): PendingDigestRow[] {
    const rows = this.db
      .prepare<[number], PendingDigestRow>(
        "SELECT * FROM pending_digest WHERE chat_id = ? ORDER BY created_at ASC"
      )
      .all(chatId);
    this.db.prepare("DELETE FROM pending_digest WHERE chat_id = ?").run(chatId);
    return rows;
  }
}
