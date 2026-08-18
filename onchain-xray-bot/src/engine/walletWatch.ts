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
export function detectBuys(tx: HeliusTx, wallet: string): WalletBuy[] {
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
  if (solSpent < MIN_BUY_SOL) return [];

  const gained = new Map<string, number>();
  for (const acc of tx.accountData ?? []) {
    for (const chg of acc.tokenBalanceChanges ?? []) {
      if (chg.userAccount !== wallet) continue;
      if (chg.mint === SOL_MINT || STABLES.has(chg.mint)) continue;
      const raw = Number(chg.rawTokenAmount.tokenAmount);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const amount = raw / 10 ** chg.rawTokenAmount.decimals;
      gained.set(chg.mint, (gained.get(chg.mint) ?? 0) + amount);
    }
  }

  const buys: WalletBuy[] = [];
  for (const [mint, tokenAmount] of gained) {
    if (tokenAmount <= 0) continue;
    if (isNonTrader('solana', mint)) continue;
    buys.push({
      wallet,
      mint,
      tokenAmount,
      // Split across mints when one transaction acquired several.
      solSpent: solSpent / gained.size,
      ts: tx.timestamp,
      signature: tx.signature,
    });
  }
  return buys;
}

/** Newest-first transactions → buys, oldest first so alerts read chronologically. */
export function detectBuysAcross(txs: HeliusTx[], wallet: string): WalletBuy[] {
  return txs
    .flatMap((t) => detectBuys(t, wallet))
    .sort((a, b) => a.ts - b.ts);
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
  const merged = new Map<string, WalletBuy>();
  for (const b of buys) {
    const prev = merged.get(b.mint);
    if (!prev) {
      merged.set(b.mint, { ...b });
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
