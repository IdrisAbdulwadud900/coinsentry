import type { Db } from "./db.js";
import type { RuleConfig, RuleRow, RuleType } from "../types/domain.js";

export class RuleRepo {
  constructor(private readonly db: Db) {}

  create(chatId: number, watchId: number, tokenId: number, type: RuleType, config: RuleConfig): RuleRow {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO rules (chat_id, watch_id, token_id, type, config_json, armed, active, last_fired_at, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, NULL, ?)`
      )
      .run(chatId, watchId, tokenId, type, JSON.stringify(config), now);

    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): RuleRow | undefined {
    return this.db.prepare<[number], RuleRow>("SELECT * FROM rules WHERE id = ?").get(id);
  }

  listForWatch(watchId: number): RuleRow[] {
    return this.db
      .prepare<[number], RuleRow>("SELECT * FROM rules WHERE watch_id = ? ORDER BY created_at DESC")
      .all(watchId);
  }

  listActiveForToken(tokenId: number): RuleRow[] {
    return this.db
      .prepare<[number], RuleRow>("SELECT * FROM rules WHERE token_id = ? AND active = 1")
      .all(tokenId);
  }

  listActiveForWatch(watchId: number): RuleRow[] {
    return this.db
      .prepare<[number], RuleRow>("SELECT * FROM rules WHERE watch_id = ? AND active = 1")
      .all(watchId);
  }

  setPaused(ruleId: number, paused: boolean): void {
    this.db.prepare("UPDATE rules SET active = ? WHERE id = ?").run(paused ? 0 : 1, ruleId);
  }

  pauseAllForToken(tokenId: number): void {
    this.db.prepare("UPDATE rules SET active = 0 WHERE token_id = ?").run(tokenId);
  }

  delete(ruleId: number): void {
    this.db.prepare("DELETE FROM rules WHERE id = ?").run(ruleId);
  }

  /** Atomically updates a rule's armed/last_fired_at/active state after evaluation, in a single write. */
  updateState(ruleId: number, armed: boolean, firedNow: boolean, deactivate: boolean): void {
    this.db
      .prepare(
        `UPDATE rules SET
           armed = ?,
           active = CASE WHEN ? = 1 THEN 0 ELSE active END,
           last_fired_at = CASE WHEN ? = 1 THEN ? ELSE last_fired_at END
         WHERE id = ?`
      )
      .run(armed ? 1 : 0, deactivate ? 1 : 0, firedNow ? 1 : 0, Date.now(), ruleId);
  }

  parseConfig(rule: RuleRow): RuleConfig {
    return JSON.parse(rule.config_json) as RuleConfig;
  }
}
