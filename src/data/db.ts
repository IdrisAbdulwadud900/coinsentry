import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id TEXT NOT NULL,
  dex_id TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  pair_url TEXT NOT NULL,
  is_indexed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (chain_id, pair_address)
);

CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  initial_price_usd REAL NOT NULL,
  initial_mcap REAL,
  initial_liquidity_usd REAL,
  UNIQUE (chat_id, token_id)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  mcap REAL,
  liquidity_usd REAL,
  volume_m5 REAL,
  volume_h1 REAL,
  volume_h24 REAL,
  price_change_m5 REAL,
  price_change_h1 REAL,
  price_change_h6 REAL,
  price_change_h24 REAL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_token_ts ON snapshots(token_id, ts);

CREATE TABLE IF NOT EXISTS settings (
  chat_id INTEGER PRIMARY KEY,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  timezone TEXT,
  currency_locale TEXT
);

CREATE TABLE IF NOT EXISTS pending_digest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  reply_markup_json TEXT,
  created_at INTEGER NOT NULL
);
`;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export type Db = Database.Database;
