import type { Chain, EntryTier, WalletLedger } from '../types/domain.js';
import { TIER_META } from '../engine/entries.js';
import { TIER_META as SMART_TIER, type SmartMoney } from '../engine/smartMoney.js';
import {
  bar,
  esc,
  mult,
  pct,
  shortAddr,
  usd,
  walletUrl,
  cieloUrl,
  duration,
  compact,
} from '../util/format.js';

/**
 * The bot's visual language.
 *
 * Constraints that shape everything here:
 *  - Telegram HTML allows only b/i/u/s/code/pre/a/blockquote/tg-spoiler.
 *  - Messages cap at 4096 characters, so density matters more than decoration.
 *  - `<blockquote expandable>` collapses long sections, which is the only real
 *    progressive disclosure available inside a single message.
 *  - `<code>` is tap-to-copy, so anything a trader will paste elsewhere (full
 *    addresses) belongs in one, and anything they only need to recognise
 *    (truncated addresses) is better as a link to the explorer.
 */

export const ICON = {
  brand: '🔬',
  floor: '🎯',
  diamond: '💎',
  dev: '🧬',
  relay: '🚨',
  chart: '📈',
  money: '💰',
  liquidity: '🌊',
  holders: '👥',
  clock: '⏱',
  fire: '🔥',
  warn: '⚠️',
  link: '🔗',
  up: '▲',
  down: '▼',
  bullet: '·',
  arrow: '→',
  sub: '↳',
} as const;

export const CHAIN_BADGE: Record<Chain, string> = {
  solana: '◎ Solana',
  ethereum: '⟠ Ethereum',
  bsc: '⬡ BNB Chain',
  base: '🔵 Base',
};

/** Section heading with an optional count, kept to one line. */
export function heading(icon: string, title: string, sub?: string): string {
  const suffix = sub ? ` <i>${esc(sub)}</i>` : '';
  return `${icon} <b>${esc(title)}</b>${suffix}`;
}

/** A labelled row that lines up under a heading without a full <pre> table. */
export function row(label: string, value: string, width = 9): string {
  return `<code>${esc(label.padEnd(width))}</code> ${value}`;
}

export function tierBadge(tier: EntryTier): string {
  const m = TIER_META[tier];
  return `${m.icon} ${m.label}`;
}

/** Score meter with a band label, e.g. ██████░░░░ 62 ELEVATED. */
export function meter(score: number, width = 10): string {
  return `<code>${bar(score / 100, width, '░')}</code> <b>${score}</b>`;
}

/** Status of a wallet's position, as a compact badge. */
export function positionBadge(l: WalletLedger): string {
  if (l.stillHolding && l.sellCount === 0) return '💎 HOLDING';
  if (l.stillHolding) return '🤝 PARTIAL';
  // A wallet that never sold but has nothing left did not exit the market — it
  // handed the position to another address. Calling that "EXITED · $0" reads as
  // "made nothing", when it is usually the opposite: the tokens left to be sold
  // somewhere this ledger cannot see. It is also the exact pattern the supply
  // relay screen exists to catch, so the two must not contradict each other.
  if (l.fullyExited && l.sellCount === 0 && l.sentTokens > 0) return '📤 SENT OUT';
  if (l.fullyExited) return '🚪 EXITED';
  return '· FLAT';
}

/**
 * PnL with directional colour cues that survive Telegram's plain styling.
 *
 * `moved` marks a wallet whose tokens left by transfer rather than by sale.
 * Its realised PnL really is zero, but printing a bare $0 states that it made
 * nothing, which is the opposite of what usually happened.
 */
export function pnl(value: number, opts: { moved?: boolean } = {}): string {
  if (opts.moved && (!Number.isFinite(value) || value === 0)) {
    return '<code>no sale on this wallet</code>';
  }
  if (!Number.isFinite(value) || value === 0) return '<code>$0</code>';
  const sign = value > 0 ? '🟩' : '🟥';
  return `${sign} <b>${usd(value, { sign: true })}</b>`;
}

/**
 * One wallet in a leaderboard. Three lines, fixed shape, so the eye can scan
 * a column of them without re-reading the labels each time.
 */
export function walletRow(
  chain: Chain,
  rank: string,
  ledger: WalletLedger,
  opts: {
    tier?: EntryTier;
    supplyPct?: number;
    note?: string;
    showMultiple?: 'held' | 'current' | 'realized';
  } = {},
): string {
  const addr = `<a href="${walletUrl(chain, ledger.wallet)}">${esc(shortAddr(ledger.wallet, 4, 4))}</a>`;
  const badge = opts.tier ? ` ${tierBadge(opts.tier)}` : '';

  const m =
    opts.showMultiple === 'realized'
      ? ledger.realizedMultiple
      : opts.showMultiple === 'current'
        ? ledger.currentMultiple
        : ledger.heldMultiple;

  // The multiple is labelled, because the same row can carry two different
  // ones and an unlabelled number invites the reader to treat them as the same
  // measurement. A holder showed "→ 54.0x" beside "100x+ club" — the first is
  // what the position is worth now, the second the peak it rode through, and
  // together they read as the bot contradicting itself.
  const mLabel =
    opts.showMultiple === 'current' ? 'now' : opts.showMultiple === 'realized' ? 'sold at' : 'rode';

  const parts = [
    `entry ${usd(ledger.entryMcap)}`,
    m > 0 ? `${mLabel} ${mult(m)}` : null,
    opts.supplyPct !== undefined && opts.supplyPct > 0 ? `${pct(opts.supplyPct, 2)} supply` : null,
  ].filter(Boolean);

  const lines = [
    `${rank} ${addr}${badge}`,
    `   <code>${esc(parts.join(' · '))}</code>`,
    `   ${pnl(ledger.totalPnlUsd, { moved: ledger.sellCount === 0 && ledger.sentTokens > 0 })} ${ICON.bullet} ${positionBadge(ledger)}`,
  ];
  if (opts.note) lines.push(`   <i>${esc(opts.note)}</i>`);
  return lines.join('\n');
}

/**
 * Lifetime-record badge. Shown only when a wallet has enough history to judge —
 * absence means unrated, never unproven.
 */
export function smartBadge(s: SmartMoney | null | undefined): string {
  if (!s || s.tier === 'unknown') return '';
  const m = SMART_TIER[s.tier];
  return `${m.icon} ${m.label} ${usd(s.totalPnlUsd, { sign: true })}`;
}

/** Compact form for a leaderboard row, where space is tight. */
export function smartChip(s: SmartMoney | null | undefined): string {
  if (!s || s.tier === 'unknown') return '';
  return `${SMART_TIER[s.tier].icon} ${usd(s.totalPnlUsd, { sign: true })} lifetime`;
}

/** Collapsible block — the only way to keep a long list in one message. */
export function expandable(inner: string): string {
  return `<blockquote expandable>${inner}</blockquote>`;
}

export function quote(inner: string): string {
  return `<blockquote>${inner}</blockquote>`;
}

/** Full address in a copyable block plus explorer links. */
export function walletFooter(chain: Chain, wallet: string): string {
  return [
    `<code>${esc(wallet)}</code>`,
    `<a href="${walletUrl(chain, wallet)}">Explorer</a> ${ICON.bullet} <a href="${cieloUrl(wallet)}">Cielo PnL</a>`,
  ].join('\n');
}

/** Human summary of how long a wallet held before its first sell. */
export function holdSummary(l: WalletLedger): string {
  if (l.sellCount === 0) {
    if (l.stillHolding) return 'never sold';
    // "no sells recorded" on an empty wallet invites the reader to assume the
    // data is missing. It is not: the tokens were moved, and where they went is
    // on the supply-relay screen.
    return l.sentTokens > 0 ? 'never sold — moved the position out' : 'no sells recorded';
  }
  return `held ${duration(l.holdSeconds ?? 0)} before first sell`;
}

/** Compact token-amount rendering used in relay descriptions. */
export function tokens(amount: number, symbol: string): string {
  return `${compact(amount)} ${esc(symbol)}`;
}

/** Truncates to Telegram's limit without splitting an HTML entity or tag. */
export function clampMessage(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  let cut = text.lastIndexOf('\n', limit);
  if (cut < limit * 0.6) cut = limit;
  return `${text.slice(0, cut)}\n\n<i>…truncated</i>`;
}

/** Live progress bar for the analysis message. */
export function progressCard(symbol: string, stage: string, detail: string | undefined, ratio: number): string {
  const filled = bar(ratio, 14, '░');
  return [
    `${ICON.brand} <b>X-RAYING ${esc(symbol || 'TOKEN')}</b>`,
    '',
    `<code>${filled}</code> ${Math.round(ratio * 100)}%`,
    '',
    `<b>${esc(stage)}</b>${detail ? `\n<i>${esc(detail)}</i>` : ''}`,
  ].join('\n');
}
