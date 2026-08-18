import type { Chain } from '../types/domain.js';

/** Telegram HTML parse_mode requires exactly these three escapes. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * $1.2K / $45.6M / $1.23 / $0.0000000123
 *
 * Sub-cent values are rendered as plain decimals, never scientific notation.
 * `toPrecision` flips to exponential below ~1e-7, and "$1.230e-8" is unreadable
 * as a price — which is a problem, because those are precisely the prices this
 * bot deals in. Four significant digits are kept at any magnitude, with
 * trailing zeros trimmed.
 */
export function usd(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = opts.sign && v > 0 ? '+' : v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a === 0) return '$0';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 1 : 2)}K`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;

  // Enough decimal places for four significant digits, capped at what toFixed
  // accepts, then trimmed — but never below two decimals, so $0.5 reads $0.50.
  const places = Math.min(100, Math.max(2, Math.ceil(-Math.log10(a)) + 3));
  let body = a.toFixed(places);
  if (body.includes('.')) {
    body = body.replace(/0+$/, '');
    const [whole, frac = ''] = body.split('.');
    body = `${whole}.${frac.padEnd(2, '0')}`;
  }
  return `${sign}$${body}`;
}

/** 12.4K / 3.1M — for token amounts and counts. */
export function compact(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(digits)}T`;
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(digits)}K`;
  if (a >= 1) return `${sign}${a.toFixed(0)}`;
  return `${sign}${a.toFixed(2)}`;
}

/**
 * Exact counts with thousands separators, compacting only once the precision
 * stops being meaningful. "3,155 trades" is information; "3K trades" is not.
 */
export function count(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const n = Math.round(v);
  return n < 1_000_000 ? n.toLocaleString('en-US') : compact(n, 1);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

/** 3.4x / 128x — multiples are the core unit of this bot. */
export function mult(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 100) return `${Math.round(v)}x`;
  if (v >= 10) return `${v.toFixed(1)}x`;
  return `${v.toFixed(2)}x`;
}

/** 2h 14m / 3d 4h / 45s — hold durations. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Relative age: "4m ago", "2d ago". */
export function ago(ts: number | null | undefined): string {
  if (!ts) return '—';
  return `${duration(Date.now() / 1000 - ts)} ago`;
}

/** 7xKq…3nP4 — short enough for a table cell, long enough to eyeball-match. */
export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

const HORIZONTAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/** Proportional bar: ratio 0-1 rendered across `width` cells with 1/8-cell precision. */
export function bar(ratio: number, width = 10, empty = '·'): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const totalEighths = Math.round(r * width * 8);
  const full = Math.floor(totalEighths / 8);
  const rem = totalEighths % 8;
  let out = '█'.repeat(Math.min(full, width));
  if (full < width && rem > 0) out += HORIZONTAL_BLOCKS[rem];
  return out.padEnd(width, empty);
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Sparkline over an arbitrary series — used for the market-cap trajectory. */
export function sparkline(values: number[], width = 24): string {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length === 0) return '';
  // Downsample to `width` buckets by averaging.
  const buckets: number[] = [];
  const per = clean.length / width;
  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    const slice = clean.slice(start, end);
    if (slice.length === 0) { buckets.push(buckets[buckets.length - 1] ?? clean[0]!); continue; }
    buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  // Log scale — memecoin charts are otherwise a flat line with one spike.
  const logs = buckets.map((v) => Math.log10(Math.max(v, 1e-12)));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const span = max - min || 1;
  return logs.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 7.999))]!).join('');
}

const MEDALS = ['🥇', '🥈', '🥉'];
/** Rank badge: medals for the podium, padded numerals after. */
export function rankBadge(i: number): string {
  return MEDALS[i] ?? `${String(i + 1).padStart(2, ' ')}.`;
}

/** Pads to a visual width for monospace <pre> blocks. */
export function padEnd(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}
export function padStart(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}

// --- Explorer deep links -----------------------------------------------------

const EXPLORER: Record<Chain, { wallet: (a: string) => string; token: (a: string) => string; tx: (h: string) => string }> = {
  solana: {
    wallet: (a) => `https://solscan.io/account/${a}`,
    token: (a) => `https://solscan.io/token/${a}`,
    tx: (h) => `https://solscan.io/tx/${h}`,
  },
  ethereum: {
    wallet: (a) => `https://etherscan.io/address/${a}`,
    token: (a) => `https://etherscan.io/token/${a}`,
    tx: (h) => `https://etherscan.io/tx/${h}`,
  },
  bsc: {
    wallet: (a) => `https://bscscan.com/address/${a}`,
    token: (a) => `https://bscscan.com/token/${a}`,
    tx: (h) => `https://bscscan.com/tx/${h}`,
  },
  base: {
    wallet: (a) => `https://basescan.org/address/${a}`,
    token: (a) => `https://basescan.org/token/${a}`,
    tx: (h) => `https://basescan.org/tx/${h}`,
  },
};

export function walletUrl(chain: Chain, addr: string): string {
  return EXPLORER[chain].wallet(addr);
}
export function tokenUrl(chain: Chain, addr: string): string {
  return EXPLORER[chain].token(addr);
}
export function txUrl(chain: Chain, hash: string): string {
  return EXPLORER[chain].tx(hash);
}
export function dexScreenerUrl(chain: Chain, pairOrToken: string): string {
  return `https://dexscreener.com/${chain}/${pairOrToken}`;
}
/** Cielo shows a wallet's full cross-token PnL — the natural "who is this?" follow-up. */
export function cieloUrl(addr: string): string {
  return `https://app.cielo.finance/profile/${addr}/pnl/tokens`;
}


