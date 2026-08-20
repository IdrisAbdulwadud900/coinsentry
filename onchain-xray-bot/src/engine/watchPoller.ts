import { config } from '../config.js';
import { log } from '../util/log.js';
import { HeliusClient } from '../data/helius.js';
import { getToken as getJupToken } from '../data/jupiter.js';
import { NativePriceOracle } from '../data/nativePrice.js';
import { isWatchableWallet, listWatched, setCursor, type WatchEntry } from '../data/watchlist.js';
import { recordBuys, findConvergence, hasRecentBuy, type Convergence } from '../data/buyLog.js';
import { detectBuysAcross, mergeBuysByMint, type WalletBuy } from './walletWatch.js';

/**
 * Checks watched wallets for new purchases.
 *
 * The expensive half of this bot answers "who was early on a coin already
 * running". This is the other direction: once a wallet has proved itself, the
 * useful question becomes what it is buying now — which is only worth anything
 * if the answer arrives quickly and without burning the request budget.
 *
 * A check is therefore one signature listing per wallet, bounded by the last
 * signature already seen. Transactions are hydrated only when that listing
 * comes back non-empty, so an idle wallet costs a single small request.
 */

export interface BuyAlert extends WalletBuy {
  chatId: number;
  note: string;
  symbol: string;
  name: string;
  mcapUsd: number;
  usdSpent: number;
  /** Safety flags from the token's own audit, so the alert is actionable. */
  freezeAuthorityActive: boolean;
  mintAuthorityActive: boolean;
  /** Set when other tracked wallets bought the same token in the window. */
  convergence: Convergence | null;
}

/** Guards against re-alerting if a cursor write is lost. */
const alerted = new Set<string>();

export async function pollWatchlist(): Promise<BuyAlert[]> {
  const helius = HeliusClient.fromConfig();
  if (!helius) return [];

  const entries = await listWatched();
  if (entries.length === 0) return [];

  const oracle = await NativePriceOracle.create('solana', Math.floor(Date.now() / 1000) - 86_400).catch(
    () => null,
  );

  const alerts: BuyAlert[] = [];
  for (const entry of entries) {
    // Entries stored before tracking was restricted to Solana would fail on
    // every poll forever, logging a warning nobody reads.
    if (!isWatchableWallet(entry.wallet)) continue;
    try {
      alerts.push(...(await checkOne(helius, entry, oracle)));
    } catch (err) {
      // One bad wallet must not stop the rest of the list being checked.
      log.warn({ err, wallet: entry.wallet }, 'watchlist check failed');
    }
  }
  return alerts;
}

async function checkOne(
  helius: HeliusClient,
  entry: WatchEntry,
  oracle: NativePriceOracle | null,
): Promise<BuyAlert[]> {
  const sigs = await helius.listSignatures(
    entry.wallet,
    config.WATCH_MAX_NEW_SIGNATURES,
    undefined,
    entry.lastSignature ?? undefined,
  );
  if (sigs.length === 0) return [];

  const newest = sigs[0]!.signature;

  // First sight of a wallet establishes a baseline. Alerting on its entire
  // backlog the moment it is added would bury the user in history they did not
  // ask for and did not act on.
  if (!entry.lastSignature) {
    await setCursor(entry.chatId, entry.wallet, newest);
    return [];
  }

  const { txs } = await helius.hydrate(sigs.map((s) => s.signature));
  const raw = detectBuysAcross(txs, entry.wallet);
  await setCursor(entry.chatId, entry.wallet, newest);

  const buys = mergeBuysByMint(raw);

  const out: BuyAlert[] = [];
  for (const buy of buys) {
    if (buy.solSpent < config.WATCH_MIN_SOL) continue;

    // Suppressed across cycles too — the cooldown is what stops a wallet that
    // keeps adding over an hour from alerting on every poll.
    const cooling = await hasRecentBuy(
      entry.chatId,
      entry.wallet,
      buy.mint,
      config.ALERT_COOLDOWN_MINUTES * 60,
    );

    const dedupe = `${entry.chatId}:${buy.signature}:${buy.mint}`;
    if (alerted.has(dedupe)) continue;
    alerted.add(dedupe);

    const meta = await getJupToken(buy.mint);
    const solPrice = oracle?.at(buy.ts) ?? 0;
    const symbol = meta?.symbol ?? buy.mint.slice(0, 6);

    // Recorded even when the alert is suppressed: the buy still happened, and
    // it still counts toward convergence with other wallets.
    await recordBuys([
      { chatId: entry.chatId, wallet: entry.wallet, mint: buy.mint, symbol, solSpent: buy.solSpent, ts: buy.ts },
    ]);

    if (cooling) continue;

    out.push({
      ...buy,
      chatId: entry.chatId,
      note: entry.note,
      symbol,
      name: meta?.name ?? 'Unknown token',
      mcapUsd: meta?.mcap ?? 0,
      usdSpent: buy.solSpent * solPrice,
      // Jupiter reports these as "disabled" flags; absent means unknown, which
      // must not read as safe.
      freezeAuthorityActive: meta?.audit?.freezeAuthorityDisabled === false,
      mintAuthorityActive: meta?.audit?.mintAuthorityDisabled === false,
      convergence: await findConvergence(entry.chatId, buy.mint),
    });
  }

  // Keep the dedupe set from growing without bound over a long uptime.
  if (alerted.size > 5_000) alerted.clear();
  return out;
}
