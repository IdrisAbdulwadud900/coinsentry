import type { Db } from "./db.js";
import type { SettingsRow } from "../types/domain.js";

const DEFAULTS: Omit<SettingsRow, "chat_id"> = {
  quiet_hours_start: null,
  quiet_hours_end: null,
  timezone: "UTC",
  currency_locale: "en-US",
};

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(chatId: number): SettingsRow {
    const row = this.db
      .prepare<[number], SettingsRow>("SELECT * FROM settings WHERE chat_id = ?")
      .get(chatId);
    if (row) return row;
    return { chat_id: chatId, ...DEFAULTS };
  }

  upsert(chatId: number, patch: Partial<Omit<SettingsRow, "chat_id">>): SettingsRow {
    const current = this.get(chatId);
    const merged: SettingsRow = { ...current, ...patch, chat_id: chatId };

    this.db
      .prepare(
        `INSERT INTO settings (chat_id, quiet_hours_start, quiet_hours_end, timezone, currency_locale)
         VALUES (@chat_id, @quiet_hours_start, @quiet_hours_end, @timezone, @currency_locale)
         ON CONFLICT(chat_id) DO UPDATE SET
           quiet_hours_start = excluded.quiet_hours_start,
           quiet_hours_end = excluded.quiet_hours_end,
           timezone = excluded.timezone,
           currency_locale = excluded.currency_locale`
      )
      .run(merged);

    return merged;
  }

  /** Returns true if "now" (in the chat's configured timezone) falls within quiet hours. */
  isQuietHoursNow(chatId: number, now: Date = new Date()): boolean {
    const settings = this.get(chatId);
    if (!settings.quiet_hours_start || !settings.quiet_hours_end) return false;

    const tz = settings.timezone ?? "UTC";
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const currentHm = formatter.format(now); // "HH:MM"

    const start = settings.quiet_hours_start;
    const end = settings.quiet_hours_end;

    if (start <= end) {
      return currentHm >= start && currentHm < end;
    }
    // Wraps past midnight, e.g. 22:00 -> 07:00
    return currentHm >= start || currentHm < end;
  }
}
