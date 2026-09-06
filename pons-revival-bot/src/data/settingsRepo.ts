import type { Db } from "./db.js";

/** Owner-writable runtime overrides (currently: ClassifierConfig field overrides set via
 * /setconfig), persisted so they survive restarts. Absent keys simply fall back to the
 * env-sourced default — see buildClassifierConfig in index.ts. */
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
    return row?.value;
  }

  set(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getAll(): Record<string, string> {
    const rows = this.db.prepare<[], { key: string; value: string }>("SELECT key, value FROM settings").all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
