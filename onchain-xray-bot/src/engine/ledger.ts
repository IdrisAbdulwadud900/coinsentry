import { config } from '../config.js';
import type { Trade, SupplyTransfer, WalletLedger } from '../types/domain.js';
import { PriceCurve } from './priceCurve.js';

/**
 * Reconstructs every wallet's full position from the trade and transfer stream.
 *
 * Cost basis is average-cost rather than FIFO. For memecoin analysis the
 * question is "what did they pay on the way in", and average cost answers that
 * without imposing a lot ordering the chain never actually recorded.
 */
export function buildLedgers(
  trades: Trade[],
  transfers: SupplyTransfer[],
  curve: PriceCurve,
  currentPriceUsd: number,
  currentMcap = 0,
): Map<string, WalletLedger> {
  const byWallet = new Map<string, Trade[]>();
  for (const t of trades) {
    let arr = byWallet.get(t.wallet);
    if (!arr) byWallet.set(t.wallet, (arr = []));
    arr.push(t);
  }

  // Net token flow from non-swap transfers, tracked separately so a wallet that
  // was handed supply is never mistaken for one that bought it.
  const received = new Map<string, number>();
  const sent = new Map<string, number>();
  for (const tr of transfers) {
    received.set(tr.to, (received.get(tr.to) ?? 0) + tr.tokenAmount);
    sent.set(tr.from, (sent.get(tr.from) ?? 0) + tr.tokenAmount);
    if (!byWallet.has(tr.to)) byWallet.set(tr.to, []);
    if (!byWallet.has(tr.from)) byWallet.set(tr.from, []);
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const ledgers = new Map<string, WalletLedger>();

  for (const [wallet, walletTrades] of byWallet) {
    walletTrades.sort((a, b) => a.ts - b.ts || a.block - b.block);

    let boughtTokens = 0;
    let boughtUsd = 0;
    let soldTokens = 0;
    let soldUsd = 0;
    let buyCount = 0;
    let sellCount = 0;
    let firstBuyTs = 0;
    let firstBuyPrice = 0;
    let firstBuyMcap = 0;
    let firstSellTs: number | null = null;

    for (const t of walletTrades) {
      if (t.side === 'buy') {
        if (buyCount === 0) {
          firstBuyTs = t.ts;
          firstBuyPrice = t.priceUsd;
          firstBuyMcap = t.mcap;
        }
        boughtTokens += t.tokenAmount;
        boughtUsd += t.usd;
        buyCount++;
      } else {
        if (sellCount === 0) firstSellTs = t.ts;
        soldTokens += t.tokenAmount;
        soldUsd += t.usd;
        sellCount++;
      }
    }

    const recv = received.get(wallet) ?? 0;
    const sentOut = sent.get(wallet) ?? 0;

    const avgBuyPrice = boughtTokens > 0 ? boughtUsd / boughtTokens : 0;
    const avgSellPrice = soldTokens > 0 ? soldUsd / soldTokens : 0;
    const balance = Math.max(0, boughtTokens + recv - soldTokens - sentOut);

    // Only tokens the wallet actually paid for carry a cost basis; airdropped
    // or relayed supply is treated as zero-cost so it cannot fake a loss.
    //
    // Cost basis is consumed as it is sold. Charging the remaining balance
    // against `boughtTokens` would re-expense basis that selling already used
    // up, understating the unrealized gain of anyone who recovered their stake
    // and is now riding free tokens — exactly the wallets this bot ranks.
    const soldAgainstBasis = Math.min(soldTokens, boughtTokens);
    const realizedUsd = soldUsd - soldAgainstBasis * avgBuyPrice;
    const unsoldPaidTokens = Math.max(0, boughtTokens - soldAgainstBasis);
    const unrealizedUsd =
      balance * currentPriceUsd - Math.min(balance, unsoldPaidTokens) * avgBuyPrice;
    const totalPnlUsd = realizedUsd + unrealizedUsd;

    const everHeld = boughtTokens + recv;
    const disposed = soldTokens + sentOut;
    const fullyExited = everHeld > 0 && disposed / everHeld >= config.FULL_EXIT_RATIO;
    const stillHolding = balance > 0 && !fullyExited;

    const windowEnd = firstSellTs ?? nowTs;
    let peakBeforeSell = firstBuyTs > 0 ? curve.peak(firstBuyTs, windowEnd) : 0;

    // The curve only covers the replayed window. A wallet that never sold has
    // demonstrably held through today's market cap, even when the replay stops
    // short of it — without this, a truncated history reports a peak below the
    // wallet's own current multiple, which cannot be true.
    if (firstSellTs === null && currentMcap > peakBeforeSell) {
      peakBeforeSell = currentMcap;
    }

    const lastTrade = walletTrades[walletTrades.length - 1];
    const lastActivityTs = lastTrade?.ts ?? firstBuyTs;

    ledgers.set(wallet, {
      wallet,
      firstBuyTs,
      lastActivityTs,
      entryMcap: firstBuyMcap,
      entryPriceUsd: firstBuyPrice,
      avgBuyPriceUsd: avgBuyPrice,
      avgBuyMcap: firstBuyMcap > 0 && firstBuyPrice > 0 ? (avgBuyPrice / firstBuyPrice) * firstBuyMcap : 0,
      totalBoughtTokens: boughtTokens,
      totalSoldTokens: soldTokens,
      totalBoughtUsd: boughtUsd,
      totalSoldUsd: soldUsd,
      receivedTokens: recv,
      sentTokens: sentOut,
      balanceTokens: balance,
      unrealizedUsd,
      realizedUsd,
      totalPnlUsd,
      roi: boughtUsd > 0 ? totalPnlUsd / boughtUsd : 0,
      peakMcapBeforeFirstSell: peakBeforeSell,
      heldMultiple: firstBuyMcap > 0 ? peakBeforeSell / firstBuyMcap : 0,
      realizedMultiple: avgBuyPrice > 0 && avgSellPrice > 0 ? avgSellPrice / avgBuyPrice : 0,
      currentMultiple: firstBuyPrice > 0 ? currentPriceUsd / firstBuyPrice : 0,
      firstSellTs,
      holdSeconds: firstSellTs !== null && firstBuyTs > 0 ? firstSellTs - firstBuyTs : null,
      stillHolding,
      fullyExited,
      buyCount,
      sellCount,
      trades: walletTrades,
    });
  }

  return ledgers;
}

/** Fills in the USD value of each non-swap transfer from the price curve. */
export function priceTransfers(transfers: SupplyTransfer[], curve: PriceCurve): void {
  for (const tr of transfers) {
    tr.usdAtTransfer = tr.tokenAmount * curve.priceAt(tr.ts);
  }
}
