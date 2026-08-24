import { config } from '../config.js';
import type { Chain } from '../types/domain.js';
import { log } from '../util/log.js';
import { HeliusClient } from '../data/helius.js';
import { EvmClient } from '../data/evmPair.js';
import { lookupToken, nativePriceUsd } from '../data/dexscreener.js';
import { CHAINS, normalizeAddress } from '../data/chains.js';
import { classifyEvmActivity, type TransferLog } from './evmWalletWatch.js';
import { getToken as getJupToken } from '../data/jupiter.js';
import { NativePriceOracle } from '../data/nativePrice.js';
import {
  chainOf,
  filterOf,
  isWatchableWallet,
  markChecked,
  setBlockCursor,
  listWatched,
  setCursor,
  type WatchEntry,
} from '../data/watchlist.js';
import { recordBuys, findConvergence, hasRecentBuy, type Convergence } from '../data/buyLog.js';
import { detectActivityAcross, matchesFilter, mergeBuysByMint, type WalletBuy } from './walletWatch.js';

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
  /** Which chain the wallet is on, so links point at the right explorer. */
  chain?: Chain;
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
    // EVM wallets are read from Transfer logs rather than Helius, so they take
    // a different path entirely — but produce the same alerts.
    if (chainOf(entry) !== 'solana') {
      try {
        alerts.push(...(await checkEvmWallet(entry)));
      } catch (err) {
        log.warn({ err, wallet: entry.wallet }, 'evm watchlist check failed');
      }
      continue;
    }
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

/**
 * One EVM wallet, from the block it was last seen at to the chain head.
 *
 * The first sight of a wallet only records where the chain is, exactly as the
 * Solana path does: alerting on a backlog the moment someone starts following
 * is how a useful feed becomes a muted one.
 */
/**
 * ERC-20 decimals, cached for the process.
 *
 * A watcher sees the same tokens repeatedly, and the answer never changes.
 */
const decimalsCache = new Map<string, number>();

/**
 * USD value of a trade's quote leg.
 *
 * Stablecoins are a dollar; wrapped native is worth whatever the native asset
 * is. Both are known without any listing for the token being traded, which is
 * what lets an unlisted coin still produce a sized alert.
 */
async function quoteUsd(chain: Chain, quoteToken: string | null, raw: bigint): Promise<number> {
  if (!quoteToken || raw <= 0n) return 0;
  const spec = CHAINS[chain];
  const isStable = spec.stables.some((sx) => normalizeAddress(sx) === normalizeAddress(quoteToken));
  const decimals = await tokenDecimals(chain, quoteToken);
  const amount = Number(raw) / 10 ** decimals;
  if (isStable) return amount;
  if (normalizeAddress(quoteToken) === normalizeAddress(spec.wrappedNative)) {
    const px = await nativePriceUsd(chain).catch(() => 0);
    return amount * px;
  }
  return 0;
}

async function tokenDecimals(chain: Chain, token: string): Promise<number> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const basics = await new EvmClient(chain).tokenBasics(token).catch(() => null);
  const d = basics?.decimals ?? 18;
  decimalsCache.set(key, d);
  return d;
}

async function checkEvmWallet(entry: WatchEntry): Promise<BuyAlert[]> {
  const chain = chainOf(entry);
  const evm = new EvmClient(chain);
  const head = await evm.headBlock();

  if (!entry.lastBlock) {
    await setBlockCursor(entry.chatId, entry.wallet, Number(head));
    await markChecked(entry.chatId, entry.wallet, null);
    return [];
  }

  // Bounded, so a wallet left unchecked for a day cannot ask for a month of
  // chain in one request and fail on every poll thereafter.
  const from = BigInt(Math.max(entry.lastBlock + 1, Number(head) - config.WATCH_EVM_MAX_BLOCKS));
  if (from > head) {
    await markChecked(entry.chatId, entry.wallet, null);
    return [];
  }

  const { logs, failed } = await evm.walletTransfers(entry.wallet, from, head);
  if (failed) return [];

  await setBlockCursor(entry.chatId, entry.wallet, Number(head));
  await markChecked(entry.chatId, entry.wallet, logs.length > 0 ? Math.floor(Date.now() / 1000) : null);

  const filter = filterOf(entry);
  const acts = classifyEvmActivity(logs as TransferLog[], entry.wallet, chain).filter((a) =>
    matchesFilter(a.kind, filter),
  );

  const out: BuyAlert[] = [];
  for (const a of acts) {
    const dedupe = `${entry.chatId}:${a.tx}:${a.token}`;
    if (alerted.has(dedupe)) continue;
    alerted.add(dedupe);

    const info = await lookupToken(a.token).catch(() => null);
    const traded = a.kind === 'buy' || a.kind === 'sell';

    // A trade is sized from its QUOTE leg, not the token's listed price.
    //
    // That matters more than it sounds. Requiring a DexScreener listing to
    // value a trade throws away the most valuable alert this bot can send —
    // a tracked wallet buying something before anyone has indexed it. A quote
    // leg is its own proof that a market exists and that real money moved,
    // and WETH and stablecoins can always be valued.
    const usdValue = traded
      ? await quoteUsd(chain, a.quoteToken, a.quoteRaw)
      : info
        ? (Number(a.tokenAmountRaw) / 10 ** (await tokenDecimals(chain, a.token))) *
          info.best.priceUsd
        : 0;

    if (traded) {
      if (usdValue < config.WATCH_EVM_MIN_USD) continue;
    } else {
      // Transfers have no quote leg, and unsolicited airdrops are the dominant
      // noise on EVM — an active address receives worthless tokens constantly,
      // and every one is a transfer-in. Liquidity is the gate here, being the
      // one number a spammer cannot fake cheaply.
      if (!info || info.best.liquidityUsd < config.WATCH_EVM_MIN_LIQUIDITY_USD) continue;
      if (usdValue > 0 && usdValue < config.WATCH_EVM_MIN_USD) continue;
    }

    const decimals = await tokenDecimals(chain, a.token);
    const tokenAmount = Number(a.tokenAmountRaw) / 10 ** decimals;

    out.push({
      wallet: entry.wallet,
      mint: a.token,
      tokenAmount,
      solSpent: 0,
      ts: Math.floor(Date.now() / 1000),
      signature: a.tx,
      kind: a.kind,
      chatId: entry.chatId,
      note: entry.note,
      // An unlisted token has no name yet; its address is the honest label.
      symbol: info?.best.symbol ?? `${a.token.slice(0, 6)}…`,
      name: info?.best.name ?? 'Unlisted token',
      mcapUsd: info?.best.mcap ?? 0,
      usdSpent: usdValue,
      // Solana-only safety flags; absent must not read as safe.
      freezeAuthorityActive: false,
      mintAuthorityActive: false,
      // Convergence is recorded from Solana buys only, so an EVM alert makes
      // no claim about it rather than a false one.
      convergence: null,
      chain,
    });
  }
  return out;
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
  // Recorded even when nothing happened. "Checked, nothing to report" is the
  // answer a user needs to distinguish a quiet wallet from a dead watcher.
  if (sigs.length === 0) {
    await markChecked(entry.chatId, entry.wallet, null);
    return [];
  }

  const newest = sigs[0]!.signature;

  // First sight of a wallet establishes a baseline. Alerting on its entire
  // backlog the moment it is added would bury the user in history they did not
  // ask for and did not act on.
  if (!entry.lastSignature) {
    await setCursor(entry.chatId, entry.wallet, newest);
    return [];
  }

  await markChecked(entry.chatId, entry.wallet, sigs[0]?.blockTime ?? null);

  const { txs } = await helius.hydrate(sigs.map((s) => s.signature));
  const filter = filterOf(entry);
  const raw = detectActivityAcross(txs, entry.wallet).filter((a) => matchesFilter(a.kind, filter));
  await setCursor(entry.chatId, entry.wallet, newest);

  const buys = mergeBuysByMint(raw);

  const out: BuyAlert[] = [];
  for (const buy of buys) {
    // A size floor only makes sense where SOL changed hands. A transfer moves
    // no SOL by definition, so applying it there would silently discard every
    // transfer the user asked to see.
    const priced = buy.kind === 'buy' || buy.kind === 'sell';
    if (priced && buy.solSpent < config.WATCH_MIN_SOL) continue;

    // Suppressed across cycles too — the cooldown is what stops a wallet that
    // keeps adding over an hour from alerting on every poll.
    // Scoped to buys: the cooldown exists to stop a wallet adding to one
    // position all hour from alerting every poll. A sell of that same token is
    // a different event and must not be swallowed by it.
    const cooling =
      buy.kind !== 'buy'
        ? false
        : await hasRecentBuy(
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

    // Buys only. Convergence means "two tracked wallets BOUGHT the same coin",
    // and now that the poller also sees sells and transfers, logging those here
    // would let two wallets DUMPING a token raise a signal that reads as them
    // accumulating it.
    //
    // Recorded even when the alert itself is suppressed: the buy still
    // happened, and it still counts toward convergence.
    if (buy.kind === 'buy') {
      await recordBuys([
        { chatId: entry.chatId, wallet: entry.wallet, mint: buy.mint, symbol, solSpent: buy.solSpent, ts: buy.ts },
      ]);
    }

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
      // Only a purchase can converge with other purchases.
      convergence: buy.kind === 'buy' ? await findConvergence(entry.chatId, buy.mint) : null,
    });
  }

  // Keep the dedupe set from growing without bound over a long uptime.
  if (alerted.size > 5_000) alerted.clear();
  return out;
}
