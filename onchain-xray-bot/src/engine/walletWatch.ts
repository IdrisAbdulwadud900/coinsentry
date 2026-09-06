import type { HeliusTx } from '../data/helius.js';
import { CHAINS } from '../data/chains.js';
import { isNonTrader } from '../data/knownAddresses.js';

/**
 * Detects what a watched wallet just bought.
 *
 * The token-level analysis asks "who bought THIS coin". This asks the inverse —
 * "what did this wallet buy" — with no mint known in advance, so the acquired
 * token has to be discovered from the transaction rather than filtered for.
 */

const LAMPORTS = 1e9;

/**
 * Floor for treating SOL movement as payment. Comfortably above the rent for
 * two associated token accounts (~0.00408 SOL) and far below any purchase
 * anyone would want to hear about.
 */
const MIN_BUY_SOL = 0.005;
const SOL_MINT = CHAINS.solana.wrappedNative;
const STABLES = new Set(CHAINS.solana.stables);

export interface WalletBuy {
  wallet: string;
  mint: string;
  tokenAmount: number;
  solSpent: number;
  ts: number;
  signature: string;
  /**
   * What the wallet actually did. A buy and a transfer in both raise the token
   * balance, and only the SOL leg tells them apart — so this is derived once,
   * here, rather than guessed by every reader.
   */
  kind: ActivityKind;
}

export type ActivityKind = 'buy' | 'sell' | 'transfer-in' | 'transfer-out';

/** Which kinds a watcher wants to hear about. */
export type WatchFilter = 'buys' | 'sells' | 'transfers' | 'all';

const FILTER_KINDS: Record<WatchFilter, ActivityKind[]> = {
  buys: ['buy'],
  sells: ['sell'],
  transfers: ['transfer-in', 'transfer-out'],
  all: ['buy', 'sell', 'transfer-in', 'transfer-out'],
};

export function matchesFilter(kind: ActivityKind, filter: WatchFilter): boolean {
  return FILTER_KINDS[filter].includes(kind);
}

/**
 * Extracts token purchases made by `wallet` in one transaction.
 *
 * A buy is a token balance going up for the wallet while its SOL goes down.
 * Both halves are required: the increase alone also matches an airdrop, a
 * transfer in, or an LP withdrawal, none of which say anything about
 * conviction — and a watchlist that cried "bought!" on every inbound token
 * would be noise within a day.
 */
/**
 * Everything `wallet` did with tokens in one transaction.
 *
 * The SOL leg is what separates the four cases. A balance going up is a buy if
 * SOL went out to pay for it and a transfer in if it did not; a balance going
 * down is a sell if SOL came back and a transfer out if it did not. Reading the
 * token side alone would file an airdrop as a purchase and a wallet quietly
 * moving its position to an alt as a sale — and that second one is the whole
 * pattern the supply-relay screen exists to catch.
 */
export function detectActivity(tx: HeliusTx, wallet: string): WalletBuy[] {
  if (!tx || tx.transactionError) return [];
  // Only the wallet's own transactions count. A tx it merely appears in — as a
  // counterparty, or because a bot paid the fee — is not its decision.
  if (tx.feePayer !== wallet) return [];

  let lamportsDelta = 0;
  for (const acc of tx.accountData ?? []) {
    if (acc.account === wallet) lamportsDelta += acc.nativeBalanceChange;
  }
  // The fee is paid regardless and is not part of the purchase.
  lamportsDelta += tx.fee ?? 0;
  const solSpent = -lamportsDelta / LAMPORTS;

  // Must exceed the cost of merely opening token accounts. Solana charges
  // ~0.00204 SOL of rent per associated token account, and a transaction that
  // creates two pays over 0.004 — so a 0.001 floor let pure account setup
  // through as a "purchase" of the token it had just made room for.
  // Rent for opening token accounts is not a purchase, and it is not proceeds
  // either — so the same floor decides "SOL really moved" in both directions.
  const paid = solSpent >= MIN_BUY_SOL;
  const received = -solSpent >= MIN_BUY_SOL;

  const moved = new Map<string, number>();
  for (const acc of tx.accountData ?? []) {
    for (const chg of acc.tokenBalanceChanges ?? []) {
      if (chg.userAccount !== wallet) continue;
      if (chg.mint === SOL_MINT || STABLES.has(chg.mint)) continue;
      const raw = Number(chg.rawTokenAmount.tokenAmount);
      if (!Number.isFinite(raw) || raw === 0) continue;
      const amount = raw / 10 ** chg.rawTokenAmount.decimals;
      moved.set(chg.mint, (moved.get(chg.mint) ?? 0) + amount);
    }
  }

  const out: WalletBuy[] = [];
  for (const [mint, delta] of moved) {
    if (delta === 0) continue;
    if (isNonTrader('solana', mint)) continue;

    const kind: ActivityKind =
      delta > 0 ? (paid ? 'buy' : 'transfer-in') : received ? 'sell' : 'transfer-out';

    out.push({
      wallet,
      mint,
      tokenAmount: Math.abs(delta),
      // Split across mints when one transaction touched several. Always the
      // magnitude: "how much SOL was involved", not which way it went, since
      // `kind` already carries the direction.
      solSpent: Math.abs(solSpent) / moved.size,
      ts: tx.timestamp,
      signature: tx.signature,
      kind,
    });
  }
  return out;
}

/** Buys only, which is what the convergence check means by a purchase. */
export function detectBuys(tx: HeliusTx, wallet: string): WalletBuy[] {
  return detectActivity(tx, wallet).filter((a) => a.kind === 'buy');
}

/** Newest-first transactions → buys, oldest first so alerts read chronologically. */
export function detectBuysAcross(txs: HeliusTx[], wallet: string): WalletBuy[] {
  return txs.flatMap((t) => detectBuys(t, wallet)).sort((a, b) => a.ts - b.ts);
}

/** Every kind, oldest first, so a feed reads in the order things happened. */
export function detectActivityAcross(txs: HeliusTx[], wallet: string): WalletBuy[] {
  return txs.flatMap((t) => detectActivity(t, wallet)).sort((a, b) => a.ts - b.ts);
}

/**
 * Collapses repeat buys of the same token into one.
 *
 * A wallet building a position over several transactions made a single
 * decision. Reporting it once per transaction is how a useful feed becomes a
 * muted one — and the combined size is the more honest number anyway, since it
 * is what the wallet actually committed.
 */
export function mergeBuysByMint(buys: WalletBuy[]): WalletBuy[] {
  // Keyed by mint AND kind. A wallet that bought and then sold the same token
  // made two decisions, and folding them together would net them into a single
  // meaningless row — or worse, report a sale as a purchase.
  const merged = new Map<string, WalletBuy>();
  for (const b of buys) {
    const key = `${b.mint}:${b.kind}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...b });
      continue;
    }
    prev.solSpent += b.solSpent;
    prev.tokenAmount += b.tokenAmount;
    // Keep the most recent transaction, so the alert links to the latest buy.
    if (b.ts >= prev.ts) {
      prev.ts = b.ts;
      prev.signature = b.signature;
    }
  }
  return [...merged.values()].sort((a, b) => a.ts - b.ts);
}
