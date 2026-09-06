import { config } from '../config.js';
import type { FirstBuyer, TokenResult } from '../data/solanatracker.js';

/**
 * Traders who made real money on this coin AND have done it repeatedly.
 *
 * The rest of this bot reconstructs a token's history transaction by
 * transaction. That is the right tool for asking who was standing at the floor,
 * but it is the wrong tool for the question people actually act on: which of
 * these wallets is worth following. Scanning more transactions cannot answer
 * that, because the evidence lives in OTHER coins.
 *
 * So this path reads a precomputed leaderboard for the coin, then asks each
 * candidate one question — how many other coins have you done this on. Two
 * requests deep instead of thousands, and it answers something the full replay
 * never could.
 *
 * Four filters, in order of how much they remove:
 *
 *  1. Profit floor. A wallet up $12 is noise however good the percentage looks.
 *  2. Return multiple. Making $300 on $30,000 is not the same skill as making
 *     $300 on $100, and only the second is worth copying.
 *  3. Repeat count. This is the one that matters — anyone can catch one runner.
 *  4. A minimum stake, so a wallet that turned $3 into $400 on a single lucky
 *     snipe does not outrank someone deploying real size.
 */

export interface ProvenWinner {
  wallet: string;
  /** Profit on the coin being analysed. */
  profitUsd: number;
  investedUsd: number;
  /** Return multiple on this coin. */
  multiple: number;
  stillHolding: boolean;
  /** Other coins where they cleared the same profit and multiple bars. */
  repeatWins: number;
  /** Combined profit across those other coins. */
  repeatProfitUsd: number;
  /** Their best other result, for context. */
  bestOtherMultiple: number;
  /** Total coins they have ever traded, so the hit rate is visible. */
  coinsTraded: number;
  /**
   * Other wallets that funded, or were funded by, this one AND also profited on
   * the same coin. Populated only for the top few winners, since each costs a
   * wallet-history lookup.
   */
  sideWallets: import('./sideWallets.js').SideWallet[];
}

/** Does one coin's outcome clear the "made money the same way" bar? */
export function isQualifyingWin(r: TokenResult): boolean {
  return (
    r.profitUsd >= config.WINNER_MIN_PROFIT_USD &&
    r.multiple >= config.WINNER_MIN_MULTIPLE &&
    r.investedUsd >= config.WINNER_MIN_INVESTED_USD
  );
}

/** The coin-level half of the filter, applied to the leaderboard entry. */
export function qualifiesOnThisCoin(b: FirstBuyer): boolean {
  const invested = b.totalInvestedUsd;
  const multiple = invested > 0 ? (invested + b.totalPnlUsd) / invested : 0;
  return (
    b.totalPnlUsd >= config.WINNER_MIN_PROFIT_USD &&
    multiple >= config.WINNER_MIN_MULTIPLE &&
    invested >= config.WINNER_MIN_INVESTED_USD
  );
}

/**
 * Builds one winner from their record on this coin plus their other results.
 * `thisMint` is excluded from the repeat count so the coin cannot vouch for
 * itself.
 */
export function buildWinner(
  b: FirstBuyer,
  results: TokenResult[],
  thisMint: string,
): ProvenWinner {
  const others = results.filter((r) => r.mint !== thisMint);
  const wins = others.filter(isQualifyingWin);
  const invested = b.totalInvestedUsd;

  return {
    wallet: b.wallet,
    profitUsd: b.totalPnlUsd,
    investedUsd: invested,
    multiple: invested > 0 ? (invested + b.totalPnlUsd) / invested : 0,
    stillHolding: b.holdingTokens > 0 && b.holdingTokens / Math.max(b.heldTokens, 1) > 0.02,
    repeatWins: wins.length,
    repeatProfitUsd: wins.reduce((s, r) => s + r.profitUsd, 0),
    bestOtherMultiple: wins.reduce((m, r) => Math.max(m, r.multiple), 0),
    coinsTraded: results.length,
    sideWallets: [],
  };
}

/** Keeps only wallets with a genuine track record, best first. */
export function rankWinners(winners: ProvenWinner[]): ProvenWinner[] {
  return winners
    .filter((w) => w.repeatWins >= config.WINNER_MIN_REPEAT_COINS)
    .sort(
      (a, b) =>
        // Repeatability leads. A wallet that has done this eight times is a
        // better bet than one that made more on this single coin.
        b.repeatWins - a.repeatWins ||
        b.repeatProfitUsd - a.repeatProfitUsd ||
        b.profitUsd - a.profitUsd,
    );
}
