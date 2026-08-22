import { config } from '../config.js';
import type { AnalysisReport, WalletLedger } from '../types/domain.js';
import type { EntrySort } from '../engine/entries.js';

/**
 * Holds completed reports so callback navigation does not re-run the analysis.
 *
 * Callback data is capped at 64 bytes and a Solana mint alone is 44, so reports
 * are addressed by a short id. The id also indexes the wallets a user can drill
 * into, which keeps wallet buttons to a handful of bytes.
 */
export interface Session {
  id: string;
  report: AnalysisReport;
  /** Stable ordering used to address wallets from callback buttons. */
  wallets: string[];
  walletIndex: Map<string, number>;
  ledgers: Map<string, WalletLedger>;
  sort: EntrySort;
  createdAt: number;
  /** Chat the analysis was requested in, so ids cannot be probed across chats. */
  chatId: number;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 500;

function makeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function createSession(report: AnalysisReport, chatId: number): Session {
  // Ordered so the most useful wallets get the lowest indices.
  const ordered: string[] = [];
  const push = (w: string | null | undefined) => {
    if (w && !ordered.includes(w)) ordered.push(w);
  };

  for (const e of report.floorEntries) push(e.ledger.wallet);
  for (const d of report.diamondHands) push(d.ledger.wallet);
  push(report.devWallet);
  for (const l of report.linkedWallets) push(l.wallet);
  for (const r of report.supplyRelays) {
    push(r.source);
    push(r.sink);
  }

  const ledgers = new Map<string, WalletLedger>();
  for (const e of report.floorEntries) ledgers.set(e.ledger.wallet, e.ledger);
  for (const d of report.diamondHands) ledgers.set(d.ledger.wallet, d.ledger);
  for (const l of report.linkedWallets) if (l.ledger) ledgers.set(l.wallet, l.ledger);
  for (const r of report.supplyRelays) {
    ledgers.set(r.source, r.sourceLedger);
    if (r.sinkLedger) ledgers.set(r.sink, r.sinkLedger);
  }
  if (report.devLedger) ledgers.set(report.devLedger.wallet, report.devLedger);

  const session: Session = {
    id: makeId(),
    report,
    wallets: ordered,
    walletIndex: new Map(ordered.map((w, i) => [w, i])),
    ledgers,
    sort: 'earliest',
    createdAt: Date.now(),
    chatId,
  };

  sessions.set(session.id, session);
  prune();
  return session;
}

export function getSession(id: string, chatId: number): Session | null {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.chatId !== chatId) return null;
  if (Date.now() - s.createdAt > config.CACHE_TTL_SECONDS * 1000 * 4) {
    sessions.delete(id);
    return null;
  }
  return s;
}

function prune(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const sorted = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const s of sorted.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(s.id);
}

// --- Reusable analysis cache -------------------------------------------------

interface CacheEntry {
  report: AnalysisReport;
  at: number;
}
const analysisCache = new Map<string, CacheEntry>();

export function getCachedAnalysis(address: string): AnalysisReport | null {
  const hit = analysisCache.get(address);
  if (!hit) return null;
  if (Date.now() - hit.at > config.CACHE_TTL_SECONDS * 1000) {
    analysisCache.delete(address);
    return null;
  }
  return hit.report;
}

export function cacheAnalysis(address: string, report: AnalysisReport): void {
  analysisCache.set(address, { report, at: Date.now() });
  if (analysisCache.size > 200) {
    const oldest = [...analysisCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) analysisCache.delete(oldest[0]);
  }
}

// --- Per-user cooldown -------------------------------------------------------

const lastRun = new Map<number, number>();

/** Returns remaining cooldown seconds, or 0 when the user may proceed. */
export function checkCooldown(userId: number): number {
  const last = lastRun.get(userId);
  if (last === undefined) return 0;
  const elapsed = (Date.now() - last) / 1000;
  return elapsed >= config.USER_COOLDOWN_SECONDS ? 0 : Math.ceil(config.USER_COOLDOWN_SECONDS - elapsed);
}

export function markRun(userId: number): void {
  lastRun.set(userId, Date.now());
}

/**
 * Wallets a user has pasted and not yet decided about.
 *
 * Kept here, keyed by a short id, because a Solana address is 44 characters and
 * Telegram allows 64 bytes of callback data in total — putting the address in
 * the button would leave no room for the rest and fail at send time. The report
 * screens solve the same problem by addressing wallets by index.
 */
const TRACK_PROMPT_TTL_MS = config.CACHE_TTL_SECONDS * 1000 * 4;

const trackPrompts = new Map<string, { wallet: string; chatId: number; at: number }>();

export function createTrackPrompt(wallet: string, chatId: number): string {
  const id = makeId();
  // Bounded, and old entries expire, so an abandoned prompt cannot pin memory.
  for (const [key, v] of trackPrompts) {
    if (Date.now() - v.at > TRACK_PROMPT_TTL_MS) trackPrompts.delete(key);
  }
  trackPrompts.set(id, { wallet, chatId, at: Date.now() });
  return id;
}

export function getTrackPrompt(id: string, chatId: number): string | null {
  const hit = trackPrompts.get(id);
  if (!hit || hit.chatId !== chatId) return null;
  if (Date.now() - hit.at > TRACK_PROMPT_TTL_MS) {
    trackPrompts.delete(id);
    return null;
  }
  return hit.wallet;
}
