import { config } from '../config.js';
import type { SupplyTransfer, WalletLedger, SupplyRelay } from '../types/domain.js';
import { classifyEntry, minPositionUsd, type TierContext } from './entries.js';
import { isNonTrader, isExchange, addressLabel } from '../data/knownAddresses.js';
import type { Chain } from '../types/domain.js';

/**
 * Finds wallets that bought early, then pushed supply to a second wallet which
 * did the selling.
 *
 * This is the pattern that makes a chart look clean while the position is
 * actually being exited: the wallet with the good entry never prints a sell, so
 * naive "top holders still holding" checks stay green. Attributing the sink's
 * sells back to the source is the point of this module.
 *
 * The obvious false positive is a CEX deposit address, which also receives and
 * "sells". Those are identified by fan-in — many unrelated sources paying into
 * one address — and demoted rather than dropped, since a deposit address is
 * still an exit.
 */
export function findSupplyRelays(
  transfers: SupplyTransfer[],
  ledgers: Map<string, WalletLedger>,
  ctx: TierContext,
  chain: Chain = 'solana',
): SupplyRelay[] {
  if (transfers.length === 0) return [];

  // Fan-in per recipient: distinguishes a personal second wallet from a hot
  // wallet that half the chain deposits into.
  const inboundSources = new Map<string, Set<string>>();
  for (const t of transfers) {
    let set = inboundSources.get(t.to);
    if (!set) inboundSources.set(t.to, (set = new Set()));
    set.add(t.from);
  }

  // Collapse repeated transfers between the same two wallets into one relay.
  const grouped = new Map<string, SupplyTransfer[]>();
  for (const t of transfers) {
    const key = `${t.from}>${t.to}`;
    let arr = grouped.get(key);
    if (!arr) grouped.set(key, (arr = []));
    arr.push(t);
  }

  const out: SupplyRelay[] = [];

  for (const [, group] of grouped) {
    const first = group[0]!;
    const source = first.from;
    const sink = first.to;

    const sourceLedger = ledgers.get(source);
    // The source must have actually bought this coin — that entry is the
    // whole reason the relay is interesting.
    if (!sourceLedger || sourceLedger.buyCount === 0) continue;
    if (sourceLedger.totalBoughtUsd < minPositionUsd(ctx.floorMcap)) continue;

    const sourceTier = classifyEntry(sourceLedger.entryMcap, ctx);
    if (sourceTier !== 'floor' && sourceTier !== 'sub10k') continue;

    const tokensRelayed = group.reduce((s, t) => s + t.tokenAmount, 0);
    const relaySupplyPct = ctx.totalSupply > 0 ? (tokensRelayed / ctx.totalSupply) * 100 : 0;
    if (relaySupplyPct < config.RELAY_MIN_SUPPLY_PCT) continue;

    // A router or burn address is not somebody's second wallet.
    if (isNonTrader(chain, sink) || isNonTrader(chain, source)) continue;

    const sinkLedger = ledgers.get(sink) ?? null;
    if (!sinkLedger) continue;

    // Only count what the sink sold AFTER it was handed the supply.
    const firstTransferTs = Math.min(...group.map((t) => t.ts));
    let sinkSoldUsd = 0;
    let sinkSoldTokens = 0;
    let firstSellAfterTs: number | null = null;
    for (const t of sinkLedger.trades) {
      if (t.side !== 'sell' || t.ts < firstTransferTs) continue;
      sinkSoldUsd += t.usd;
      sinkSoldTokens += t.tokenAmount;
      if (firstSellAfterTs === null) firstSellAfterTs = t.ts;
    }

    // A sink may hold tokens from several places — its own buys, or relays from
    // other wallets. Crediting all of its sells to this relay would overstate
    // both the ratio and the recovered value, so sells are attributed in
    // proportion to how much of the sink's supply this relay actually provided.
    const sinkAcquired = sinkLedger.totalBoughtTokens + sinkLedger.receivedTokens;
    const relayShare = sinkAcquired > 0 ? Math.min(1, tokensRelayed / sinkAcquired) : 1;

    const attributedSoldTokens = sinkSoldTokens * relayShare;
    const sinkSellRatio = tokensRelayed > 0 ? Math.min(1, attributedSoldTokens / tokensRelayed) : 0;
    if (sinkSellRatio < config.RELAY_MIN_SINK_SELL_RATIO) continue;

    const attributedUsd = sinkSoldUsd * relayShare;

    const fanIn = inboundSources.get(sink)?.size ?? 1;
    const timeToSell = firstSellAfterTs !== null ? firstSellAfterTs - firstTransferTs : null;
    const sinkNeverBought = sinkLedger.buyCount === 0;

    const flags: string[] = [];
    let suspicion = 0;

    if (sourceTier === 'floor') {
      suspicion += 32;
      flags.push('Source caught the floor');
    } else {
      suspicion += 22;
      flags.push('Source entered sub-$10k');
    }

    if (sinkNeverBought) {
      suspicion += 26;
      flags.push('Sink never bought — pure exit wallet');
    }

    if (sinkSellRatio >= 0.9) {
      suspicion += 20;
      flags.push('Sink dumped ~everything it received');
    } else if (sinkSellRatio >= 0.7) {
      suspicion += 12;
      flags.push('Sink sold most of the relayed supply');
    }

    if (timeToSell !== null && timeToSell <= config.RELAY_FAST_SELL_SECONDS) {
      suspicion += 18;
      flags.push('Sold within hours of receiving');
    }

    // A source that keeps a clean sell history while its sink exits is the
    // strongest version of this pattern.
    if (sourceLedger.sellCount === 0) {
      suspicion += 14;
      flags.push('Source shows zero sells on-chain');
    }

    if (relaySupplyPct >= 1) {
      suspicion += 10;
      flags.push(`Moved ${relaySupplyPct.toFixed(2)}% of supply`);
    }

    // A named exchange is a certainty, not an inference — say so, and stop
    // scoring it as a covert exit. The transfer still matters: it is where the
    // supply went. It just was not a second wallet under the same control.
    const sinkLabel = addressLabel(chain, sink);
    if (isExchange(chain, sink)) {
      suspicion = Math.round(suspicion * 0.3);
      flags.push(`Sent to ${sinkLabel ?? 'an exchange'} — a deposit, not a hidden wallet`);
    } else if (fanIn >= 5) {
      suspicion = Math.round(suspicion * 0.45);
      flags.push(`Likely CEX/hot wallet (${fanIn} inbound sources)`);
    }

    out.push({
      source,
      sink,
      transfers: group,
      tokensRelayed,
      relaySupplyPct,
      sinkSoldUsd: attributedUsd,
      sinkSellRatio,
      sourceLedger,
      sinkLedger,
      sourceEntryMcap: sourceLedger.entryMcap,
      sourceEntryTier: sourceTier,
      combinedTakeUsd: sourceLedger.realizedUsd + attributedUsd,
      suspicion: Math.max(0, Math.min(100, suspicion)),
      flags,
    });
  }

  out.sort((a, b) => b.suspicion - a.suspicion || b.combinedTakeUsd - a.combinedTakeUsd);
  return out;
}
