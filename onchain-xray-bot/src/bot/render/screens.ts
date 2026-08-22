import { config } from '../../config.js';
import type { AnalysisReport, WalletLedger, SupplyRelay, LinkedWallet, ProviderEntry } from '../../types/domain.js';
import { LINK_LABEL } from '../../engine/devGraph.js';
import { sortEarlyBuyers, minPositionUsd, type EntrySort } from '../../engine/entries.js';
import { providerBucket, movedSupplyOut } from '../../engine/providerEntries.js';
import { computeVerdict } from '../../engine/verdict.js';
import { PLAY_META } from '../../engine/winningPlay.js';
import {
  esc,
  usd,
  pct,
  mult,
  compact,
  rankBadge,
  shortAddr,
  duration,
  ago,
  walletUrl,
  txUrl,
  dexScreenerUrl,
} from '../../util/format.js';
import {
  ICON,
  smartBadge,
  smartChip,
  heading,
  tierBadge,
  pnl,
  positionBadge,
  walletRow,
  walletFooter,
  quote,
  expandable,
  holdSummary,
  clampMessage,
} from '../ui.js';

export interface PageInfo {
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, size = config.LEADERBOARD_PAGE_SIZE): { slice: T[]; info: PageInfo } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return {
    slice: items.slice(p * size, p * size + size),
    info: { page: p, pages, total: items.length },
  };
}

function footer(info: PageInfo, noun: string): string {
  if (info.total === 0) return '';
  return `\n<i>page ${info.page + 1}/${info.pages} ${ICON.bullet} ${info.total} ${esc(noun)}</i>`;
}

function empty(icon: string, title: string, why: string): string {
  return `${heading(icon, title)}\n\n${quote(esc(why))}`;
}

// --- Floor entries -----------------------------------------------------------

export function renderFloorEntries(report: AnalysisReport, page: number, sort: EntrySort): string {
  const sorted = sortEarlyBuyers(report.floorEntries, sort);
  if (sorted.length === 0) {
    return empty(
      ICON.floor,
      'FLOOR ENTRIES',
      `No wallet bought inside the floor band (${usd(report.entryBandMin)} – ${usd(report.floorBandMax)}) with a position above ${usd(minPositionUsd(report.floorMcap))}. On a token that launched high, or one where the replay could not reach the launch window, this section will be thin.`,
    );
  }

  const { slice, info } = paginate(sorted, page);
  const sortLabel = { earliest: 'lowest entry first', biggest: 'biggest bag first', profit: 'most profit first' }[sort];

  const head = [
    heading(ICON.floor, 'FLOOR ENTRIES', `$${report.token.symbol.trim().toUpperCase()}`),
    '',
    report.reachedLaunch
      ? ''
      : report.floorSource === 'launchpad'
        ? `${ICON.warn} <i>The floor below is exact — it is this launchpad's fixed opening price. The wallet list, however, covers only the window the scan reached, so the earliest buyers may be missing.</i>\n`
        : `${ICON.warn} <b>Not the real floor.</b> <i>This token has too many transactions to scan back to its launch, so the figures below describe the window that was read — not the coin's bottom.</i>\n`,
    `<i>Bought inside the floor band ${usd(report.entryBandMin)} – ${usd(report.floorBandMax)}, or under ${usd(config.EARLY_MCAP_USD)} market cap.</i>`,
    report.entryBandRebased
      ? `<i>The coin's lowest print was ${usd(report.floorMcap)}, but that was a sell — no buyer could reach it. The band starts at the lowest real entry instead.</i>`
      : '',
    `<i>Positions under ${usd(minPositionUsd(report.floorMcap))} are hidden ${ICON.bullet} sorted: ${esc(sortLabel)}</i>`,
    '',
  ].join('\n');

  const body = slice
    .map((e, i) => {
      const rank = rankBadge(info.page * config.LEADERBOARD_PAGE_SIZE + i);
      // Both figures are counted from the first trade we actually saw. That is
      // the real launch only when the scan reached it; otherwise "#246 in" and
      // "5m after launch" describe the scanned window while reading as facts
      // about the coin's opening.
      const note = report.reachedLaunch
        ? `#${e.entryRank} in ${ICON.bullet} ${duration(e.secondsAfterLaunch)} after launch`
        : `#${e.entryRank} of those scanned`;
      return walletRow(report.token.chain, rank, e.ledger, {
        tier: e.tier,
        supplyPct: e.supplyPct,
        note,
        showMultiple: e.ledger.stillHolding ? 'current' : 'held',
      });
    })
    .join('\n\n');

  return clampMessage(head + body + footer(info, 'wallets'));
}

/**
 * The earliest buyers as reported by the data provider.
 *
 * Shown when our own replay could not reach the token's launch, which is the
 * normal case for a busy Solana coin. Entry figures here are exact; what is
 * missing is the per-trade history, so this screen ranks by entry and outcome
 * and does not claim a peak-while-holding it cannot compute.
 */
export function renderProviderEntries(report: AnalysisReport, page: number): string {
  const chain = report.token.chain;
  const sym = report.token.symbol.trim().toUpperCase();

  if (report.providerEntries.length === 0) {
    return empty(
      ICON.floor,
      'FIRST BUYERS',
      config.hasSolanaTracker
        ? 'The provider returned no first-buyer record for this token.'
        : 'Set SOLANATRACKER_API_KEY to recover the earliest buyers on tokens too busy to scan back to launch.',
    );
  }

  const { slice, info } = paginate(report.providerEntries, page);

  const head = [
    heading(ICON.floor, 'FIRST BUYERS', `$${sym}`),
    '',
    `<i>The earliest wallets into this coin, from SolanaTracker's first-buyer record — the launch was too far back to replay directly.</i>`,
    `<i>Entry prices are exact. How far each rode it comes from candle highs across the coin's full history.</i>`,
    '',
  ].join('\n');

  const body = slice
    .map((e, i) => renderProviderRow(report, e, info.page * config.LEADERBOARD_PAGE_SIZE + i))
    .join('\n\n');

  return clampMessage(head + body + footer(info, 'wallets'));
}

function renderProviderRow(report: AnalysisReport, e: ProviderEntry, index: number): string {
  const chain = report.token.chain;
  const addr = `<a href="${walletUrl(chain, e.wallet)}">${esc(shortAddr(e.wallet, 4, 4))}</a>`;

  const status = e.stillHolding
    ? '💎 HOLDING'
    : e.sellCount > 0
      ? '🚪 EXITED'
      : '· FLAT';

  const move = e.stillHolding ? e.currentMultiple : e.realizedMultiple;
  const parts = [
    `entry ${usd(e.entryMcap)}`,
    move > 0 ? `${ICON.arrow} ${mult(move)}` : null,
    e.supplyPct > 0 ? `${pct(e.supplyPct, 2)} supply` : null,
  ].filter(Boolean);

  // How far the coin ran while they held, when candles could establish it.
  const rode =
    e.heldMultiple >= 2
      ? `rode ${mult(e.heldMultiple)}${e.sellCount > 0 ? ' before selling' : ' so far'}`
      : null;

  const timing = [
    // Provider records ARE ordered from the true first buy, so the rank is
    // absolute here even when our own replay fell short.
    e.entryRank > 0 ? `#${e.entryRank} in` : null,
    rode,
    e.holdSeconds !== null ? `held ${duration(e.holdSeconds)}` : 'never sold',
  ]
    .filter(Boolean)
    .join(` ${ICON.bullet} `);

  const chip = smartChip(report.smartMoney[e.wallet]);
  return [
    `${rankBadge(index)} ${addr} ${tierBadge(e.tier)}`,
    `   <code>${esc(parts.join(' · '))}</code>`,
    `   ${pnl(e.totalPnlUsd)} ${ICON.bullet} ${status}`,
    `   <i>${esc(timing)}</i>`,
    ...(chip ? [`   ${chip}`] : []),
  ].join('\n');
}

/**
 * Traders who made money here and have done it before.
 *
 * Ranked by repeat wins rather than by profit on this coin: a wallet that has
 * pulled the same result off eight times is a better bet than one that happened
 * to make more on this single token.
 */
/**
 * Wallet clusters, shown on the winners screen.
 *
 * These are NOT filtered to proven winners on purpose. An operator who splits
 * one position across four addresses leaves four modest wallets, none of which
 * looks like a repeat performer on its own — the cluster is the finding.
 */
function clusterBlock(report: AnalysisReport): string {
  if (report.sideClusters.length === 0) return '';

  const lines = report.sideClusters.slice(0, 3).map((c) => {
    const how = c.sharedFunders > 0
      ? `${c.sharedFunders} shared funder${c.sharedFunders > 1 ? 's' : ''}`
      : 'direct transfers';
    const who = c.members
      .slice(0, 4)
      .map(
        (m) =>
          `      ${ICON.sub} <a href="${walletUrl(report.token.chain, m.wallet)}">${esc(shortAddr(m.wallet, 4, 4))}</a> ` +
          `${usd(m.profitUsd, { sign: true })} ${ICON.bullet} ${mult(m.multiple)}`,
      );
    return [
      `   🔗 <b>${c.members.length} wallets</b> ${ICON.bullet} ${usd(c.combinedProfitUsd)} combined ${ICON.bullet} <i>${how}</i>`,
      ...who,
    ].join('\n');
  });

  return [
    '',
    '',
    heading('🕸', 'LIKELY SAME OPERATOR'),
    '',
    `<i>Wallets that both profited here and were funded by the same addresses.</i>`,
    '',
    lines.join('\n\n'),
    '',
    `<blockquote><i>Shared funding is a strong hint, not proof — two traders can share a backer. Judge it by the number of shared funders.</i></blockquote>`,
  ].join('\n');
}

export function renderProvenWinners(report: AnalysisReport, page: number): string {
  const sym = report.token.symbol.trim().toUpperCase();

  if (report.provenWinners.length === 0) {
    // Clusters survive an empty winners list: splitting a position across alts
    // is exactly what keeps each wallet off a repeat-winner ranking.
    return clampMessage(
      empty(
        '🏆',
        'PROVEN WINNERS',
      report.winnersChecked > 0
        ? `Checked the ${report.winnersChecked} biggest earners on this coin. None of them had won ${config.WINNER_MIN_REPEAT_COINS}+ other coins the same way, so none qualify as repeat performers.`
        : config.hasSolanaTracker
          ? `Nobody cleared ${usd(config.WINNER_MIN_PROFIT_USD)} profit at ${config.WINNER_MIN_MULTIPLE}x or better on this coin.`
          : 'Set SOLANATRACKER_API_KEY to rank traders by their track record.',
      ) + clusterBlock(report),
    );
  }

  const { slice, info } = paginate(report.provenWinners, page);

  const head = [
    heading('🏆', 'PROVEN WINNERS', `$${sym}`),
    '',
    `<i>Made ${usd(config.WINNER_MIN_PROFIT_USD)}+ at ${config.WINNER_MIN_MULTIPLE}x+ here, AND won ${config.WINNER_MIN_REPEAT_COINS}+ other coins the same way.</i>`,
    `<i>Ranked by how often they have repeated it — not by size on this one.</i>`,
    '',
  ].join('\n');

  const body = slice
    .map((w, i) => {
      const idx = info.page * config.LEADERBOARD_PAGE_SIZE + i;
      const addr = `<a href="${walletUrl(report.token.chain, w.wallet)}">${esc(shortAddr(w.wallet, 4, 4))}</a>`;
      const hitRate = w.coinsTraded > 0 ? (w.repeatWins / w.coinsTraded) * 100 : 0;
      return [
        `${rankBadge(idx)} ${addr} ${pnl(w.profitUsd)}`,
        `   <code>${esc(`${mult(w.multiple)} on ${usd(w.investedUsd)} in`)}</code>${w.stillHolding ? ' 💎' : ''}`,
        `   🔁 <b>${w.repeatWins}</b> other coins won the same way ${ICON.bullet} ${usd(w.repeatProfitUsd)} from them`,
        `   <i>best ${mult(w.bestOtherMultiple)} elsewhere ${ICON.bullet} ${w.repeatWins}/${w.coinsTraded} coins hit (${pct(hitRate, 1)})</i>`,
        // Inference, never fact — the wording says "likely" and the evidence
        // that produced it is shown so the reader can weigh it themselves.
        ...(w.sideWallets.length > 0
          ? [
              `   🔗 <i>likely same operator ${ICON.bullet} ${w.sideWallets.length} linked wallet${w.sideWallets.length > 1 ? 's' : ''} also profited here</i>`,
              ...w.sideWallets.slice(0, 3).map((sw) => {
                const how = sw.sharedFunders > 0
                  ? `${sw.sharedFunders} shared funder${sw.sharedFunders > 1 ? 's' : ''}`
                  : 'direct transfer';
                return (
                  `      ${ICON.sub} <a href="${walletUrl(report.token.chain, sw.wallet)}">${esc(shortAddr(sw.wallet, 4, 4))}</a> ` +
                  `${usd(sw.profitUsd, { sign: true })} ${ICON.bullet} ${mult(sw.multiple)} ${ICON.bullet} <i>${how}</i>`
                );
              }),
            ]
          : []),
      ].join('\n');
    })
    .join('\n\n');

  const tail = info.page === info.pages - 1 ? clusterBlock(report) : '';
  return clampMessage(head + body + tail + footer(info, 'winners'));
}

// --- Winning play ------------------------------------------------------------

/**
 * What actually worked on this coin, by style.
 *
 * Ranked by combined profit rather than by how many wallets traded each way.
 * The popular play and the profitable one are usually not the same, and on a
 * coin where most buyers lost, counting wallets would recommend the losing one.
 */
export function renderWinningPlay(report: AnalysisReport): string {
  const sym = report.token.symbol.trim().toUpperCase();

  if (report.winningPlays.length === 0) {
    return empty(
      '🧠',
      'WINNING PLAY',
      report.token.createdAt
        ? `No wallet cleared ${usd(config.PLAY_MIN_PROFIT_USD)} profit here, so there is no winning style to report.`
        : 'The launch time for this coin is unknown, so entries cannot be measured against it.',
    );
  }

  const top = report.winningPlays[0]!;
  const total = report.winningPlays.reduce((sum, p) => sum + p.profitUsd, 0);

  const body = report.winningPlays.map((p, i) => {
    const meta = PLAY_META[p.kind];
    const share = total > 0 ? (p.profitUsd / total) * 100 : 0;
    return [
      `${i === 0 ? '🥇' : `${i + 1}.`} ${meta.icon} <b>${meta.label}</b>`,
      `   <code>${esc(`${usd(p.profitUsd)} across ${p.wallets} wallet${p.wallets > 1 ? 's' : ''}`)}</code> ${ICON.bullet} ${pct(share, 0)} of profit`,
      `   <i>${esc(meta.blurb)}</i>`,
      `   <i>typical ${mult(p.medianMultiple)}${p.medianHoldSeconds !== null ? ` ${ICON.bullet} ${p.kind.endsWith('hold') ? 'carried' : 'held'} ${duration(p.medianHoldSeconds)}` : ''}</i>`,
      `   <i>best: <a href="${walletUrl(report.token.chain, p.bestWallet)}">${esc(shortAddr(p.bestWallet, 4, 4))}</a> ${usd(p.bestProfitUsd, { sign: true })}</i>`,
    ].join('\n');
  });

  return clampMessage(
    [
      heading('🧠', 'WINNING PLAY', `$${sym}`),
      '',
      `<i>How the money was actually made here, ranked by profit — not by how many wallets did it.</i>`,
      '',
      `<b>${PLAY_META[top.kind].icon} ${esc(PLAY_META[top.kind].label)}</b> took the most out of this coin.`,
      '',
      body.join('\n\n'),
      '',
      `<blockquote><i>Only wallets up ${usd(config.PLAY_MIN_PROFIT_USD)}+ are counted, so this is what worked, not what was popular. Styles are inferred from entry timing and buy/sell counts.</i></blockquote>`,
    ].join('\n'),
  );
}

// --- Diamond hands -----------------------------------------------------------

export function renderDiamondHands(report: AnalysisReport, page: number): string {
  // On a token too busy to replay, our own ledgers contain nobody from the
  // launch, so the provider records are the only place conviction can be seen.
  if (report.diamondHands.length === 0 && report.providerDiamondHands.length > 0) {
    const { slice, info } = paginate(report.providerDiamondHands, page);
    const head = [
      heading(ICON.diamond, 'DIAMOND HANDS', `$${report.token.symbol.trim().toUpperCase()}`),
      '',
      `<i>Entered at the floor or under ${usd(config.EARLY_MCAP_USD)}, then rode ${config.diamondBuckets[0] ?? 3}x or more before selling anything.</i>`,
      `<i>From first-buyer records; the run is measured against candle highs.</i>`,
      '',
    ].join('\n');
    const body = slice
      .map((e, i) => {
        const idx = info.page * config.LEADERBOARD_PAGE_SIZE + i;
        const bucket = providerBucket(e);
        const rode = e.stillHolding ? Math.max(e.heldMultiple, e.currentMultiple) : e.heldMultiple;
        return [
          `${rankBadge(idx)} <a href="${walletUrl(report.token.chain, e.wallet)}">${esc(shortAddr(e.wallet, 4, 4))}</a> ${tierBadge(e.tier)}`,
          `   <code>${esc(`entry ${usd(e.entryMcap)} ${ICON.arrow} rode ${mult(rode)}`)}</code>`,
          `   ${pnl(e.totalPnlUsd)} ${ICON.bullet} ${e.stillHolding ? '💎 HOLDING' : '🚪 EXITED'}`,
          `   <i>${esc(`${mult(bucket)}+ club ${ICON.bullet} ${e.holdSeconds !== null ? `held ${duration(e.holdSeconds)}` : 'never sold'}`)}</i>`,
          ...(smartChip(report.smartMoney[e.wallet]) ? [`   ${smartChip(report.smartMoney[e.wallet])}`] : []),
        ].join('\n');
      })
      .join('\n\n');
    return clampMessage(head + body + footer(info, 'wallets'));
  }

  if (report.diamondHands.length === 0) {
    return empty(
      ICON.diamond,
      'DIAMOND HANDS',
      `No floor-range wallet rode this to ${config.diamondBuckets[0] ?? 3}x before its first sell. Either the coin never ran that far from its floor, or the early buyers flipped it fast.`,
    );
  }

  const { slice, info } = paginate(report.diamondHands, page);

  const head = [
    heading(ICON.diamond, 'DIAMOND HANDS', `$${report.token.symbol.trim().toUpperCase()}`),
    '',
    `<i>Entered at the floor or under ${usd(config.EARLY_MCAP_USD)}, then held while it ran ${config.diamondBuckets[0] ?? 3}x or more before taking any profit.</i>`,
    '',
  ].join('\n');

  const body = slice
    .map((d, i) => {
      const rank = rankBadge(info.page * config.LEADERBOARD_PAGE_SIZE + i);
      const club = `${mult(d.bucket)}+ club`;
      const note = `${club} ${ICON.bullet} ${holdSummary(d.ledger)}`;
      return walletRow(report.token.chain, rank, d.ledger, {
        tier: d.entryTier,
        supplyPct: d.supplyPct,
        note,
        showMultiple: d.ledger.stillHolding ? 'current' : 'held',
      });
    })
    .join('\n\n');

  return clampMessage(head + body + footer(info, 'wallets'));
}

// --- Dev cluster -------------------------------------------------------------

export function renderDevCluster(report: AnalysisReport, page: number): string {
  const chain = report.token.chain;
  if (!report.devWallet) {
    return empty(
      ICON.dev,
      'DEV CLUSTER',
      'The deployer wallet could not be identified for this token, so there is nothing to map from.',
    );
  }

  const head: string[] = [
    heading(ICON.dev, 'DEV CLUSTER', `$${report.token.symbol.trim().toUpperCase()}`),
    '',
    `<b>Deployer</b> <a href="${walletUrl(chain, report.devWallet)}">${esc(shortAddr(report.devWallet, 5, 5))}</a>`,
  ];

  const dev = report.devLedger;
  if (dev) {
    const supply = report.token.totalSupply;
    const boughtPct = supply > 0 ? ((dev.totalBoughtTokens + dev.receivedTokens) / supply) * 100 : 0;
    const holdPct = supply > 0 ? (dev.balanceTokens / supply) * 100 : 0;
    head.push(
      quote(
        [
          `acquired ${pct(boughtPct, 2)} ${ICON.bullet} holds ${pct(holdPct, 2)}`,
          `${pnl(dev.totalPnlUsd)} ${ICON.bullet} ${positionBadge(dev)}`,
          `${dev.buyCount} buys ${ICON.bullet} ${dev.sellCount} sells ${ICON.bullet} ${holdSummary(dev)}`,
        ].join('\n'),
      ),
    );
  } else {
    head.push(quote('The deployer never traded this token on-chain.'));
  }

  if (report.linkedWallets.length === 0) {
    head.push('');
    head.push('<i>No wallets could be linked to the deployer.</i>');
    return head.join('\n');
  }

  const { slice, info } = paginate(report.linkedWallets, page);
  head.push('');
  head.push(`<b>Linked wallets</b> <i>· ${report.linkedWallets.length} found</i>`);
  head.push(
    '<i>Confidence, not proof — a shared funder can also be an exchange withdrawal.</i>',
  );
  head.push('');

  const body = slice.map((l, i) => renderLinkedWallet(report, l, info.page * config.LEADERBOARD_PAGE_SIZE + i)).join('\n\n');
  return clampMessage(head.join('\n') + body + footer(info, 'linked wallets'));
}

function renderLinkedWallet(report: AnalysisReport, l: LinkedWallet, index: number): string {
  const chain = report.token.chain;
  const addr = `<a href="${walletUrl(chain, l.wallet)}">${esc(shortAddr(l.wallet, 4, 4))}</a>`;
  const lines = [
    `${rankBadge(index)} ${addr} <b>${l.strength}%</b> <i>confidence</i>`,
    `   <code>${esc(l.links.map((t) => LINK_LABEL[t]).join(' · '))}</code>`,
  ];

  if (l.ledger && l.ledger.buyCount > 0) {
    const supplyPct = report.token.totalSupply > 0 ? (l.ledger.peakTokens / report.token.totalSupply) * 100 : 0;
    lines.push(
      `   entry ${usd(l.ledger.entryMcap)} ${ICON.bullet} ${pct(supplyPct, 2)} supply ${ICON.bullet} ${positionBadge(l.ledger)}`,
    );
    lines.push(`   ${pnl(l.ledger.totalPnlUsd)}`);
  } else {
    lines.push('   <i>no trades on this token</i>');
  }

  if (l.via) lines.push(`   <i>via ${esc(shortAddr(l.via, 4, 4))}</i>`);
  return lines.join('\n');
}

// --- Supply relays -----------------------------------------------------------

export function renderRelays(report: AnalysisReport, page: number): string {
  if (report.supplyRelays.length === 0) {
    // "None found" and "could not look" are different answers, and only one of
    // them is a clean bill of health. A scan that never reached the launch
    // searched a recent window, which is where relays are least likely to be:
    // the pattern is an EARLY wallet handing supply on, so its evidence sits at
    // the start of the coin's life, exactly the part that went unread.
    // True when the transfer graph was never fully read: either the replay fell
    // short of the launch, or there was no replay at all. The fast path reports
    // reachedLaunch while replaying nothing, so that flag alone is not enough.
    const graphIncomplete = !report.reachedLaunch || report.tradeCount === 0;
    if (graphIncomplete) {
      // The transfer graph needs a replay this coin was too large for, but the
      // provider's own token counts still reveal the SOURCE half: supply that
      // left a wallet without being sold. Naming those wallets beats saying
      // "not searched", as long as it does not pretend to know where it went.
      const movers = movedSupplyOut(report.providerEntries);
      if (movers.length > 0) {
        const rows = movers.slice(0, 5).map((e) => {
          const pctMoved = (e.movedOutTokens / e.everHeldTokens) * 100;
          return (
            `${ICON.sub} <a href="${walletUrl(report.token.chain, e.wallet)}">${esc(shortAddr(e.wallet, 4, 4))}</a> ` +
            `${esc(`entry ${usd(e.entryMcap)} ${ICON.bullet} moved ${pct(pctMoved, 0)} of its position out ${ICON.bullet} ${e.sellCount} sells`)}`
          );
        });
        return clampMessage(
          [
            heading(ICON.relay, 'SUPPLY RELAYS', `$${esc(report.token.symbol.trim().toUpperCase())}`),
            '',
            `<i>The full transfer graph needs a replay this coin is too large for. These early wallets moved supply out WITHOUT selling it, which is the source half of a relay — where it went is not traced.</i>`,
            '',
            rows.join('\n'),
            '',
            `<blockquote><i>A wallet with many sells may simply be moving between its own addresses. One with none, an empty balance and a good entry is the pattern worth reading.</i></blockquote>`,
          ].join('\n'),
        );
      }
      return empty(
        ICON.relay,
        'SUPPLY RELAYS',
        'The scan could not reach this coin\'s launch, so relays were only searched in the most recent window — and no early wallet in the provider\'s records moved supply out without selling it either. A relay is an EARLY wallet passing supply to a seller, so treat this as "little sign of it", not a clean bill of health.',
      );
    }
    return empty(
      ICON.relay,
      'SUPPLY RELAYS',
      'No early wallet was seen handing supply to another address that then sold it. This is the clean result — but it only covers the transfers inside the replayed window.',
    );
  }

  const { slice, info } = paginate(report.supplyRelays, page, 4);

  const head = [
    heading(ICON.relay, 'SUPPLY RELAYS', `$${report.token.symbol.trim().toUpperCase()}`),
    '',
    '<i>An early wallet moved supply to a second address, and that address did the selling. The buyer with the good entry never prints a sell, so the position looks untouched.</i>',
    '',
  ].join('\n');

  const body = slice.map((r, i) => renderRelay(report, r, info.page * 4 + i)).join('\n\n');
  return clampMessage(head + body + footer(info, 'relays'));
}

function renderRelay(report: AnalysisReport, r: SupplyRelay, index: number): string {
  const chain = report.token.chain;
  const src = `<a href="${walletUrl(chain, r.source)}">${esc(shortAddr(r.source, 4, 4))}</a>`;
  const sink = `<a href="${walletUrl(chain, r.sink)}">${esc(shortAddr(r.sink, 4, 4))}</a>`;
  const heat = r.suspicion >= 75 ? '🔴' : r.suspicion >= 55 ? '🟠' : '🟡';

  const lines = [
    `${rankBadge(index)} ${heat} <b>${r.suspicion}</b> <i>suspicion</i>`,
    `   ${src} ${ICON.arrow} ${sink}`,
    `   <code>${esc(`entry ${usd(r.sourceEntryMcap)}`)}</code> ${tierBadge(r.sourceEntryTier)}`,
    `   moved ${pct(r.relaySupplyPct, 2)} of supply ${ICON.bullet} sink sold ${pct(r.sinkSellRatio * 100, 0)}`,
    `   sink recovered ${usd(r.sinkSoldUsd)} ${ICON.bullet} combined take ${pnl(r.combinedTakeUsd)}`,
  ];

  if (r.flags.length > 0) {
    lines.push(quote(r.flags.map((f) => `• ${esc(f)}`).join('\n')));
  }

  const firstTx = r.transfers[0];
  if (firstTx?.tx) {
    lines.push(`   <a href="${txUrl(chain, firstTx.tx)}">first transfer</a> ${ICON.bullet} ${ago(firstTx.ts)}`);
  }

  return lines.join('\n');
}

// --- Wallet detail -----------------------------------------------------------

export function renderWallet(report: AnalysisReport, ledger: WalletLedger): string {
  const chain = report.token.chain;
  const supply = report.token.totalSupply;
  const supplyPct = supply > 0 ? (ledger.peakTokens / supply) * 100 : 0;
  const holdPct = supply > 0 ? (ledger.balanceTokens / supply) * 100 : 0;
  const sym = report.token.symbol.trim().toUpperCase();

  const lines = [
    `👤 <b>${esc(shortAddr(ledger.wallet, 6, 6))}</b> <i>on $${esc(sym)}</i>`,
    '',
    quote(
      [
        `<b>Entry</b>  ${usd(ledger.entryMcap)} market cap`,
        `<b>Bought</b> ${usd(ledger.totalBoughtUsd)} ${ICON.bullet} peak ${pct(supplyPct, 2)} of supply`,
        `<b>Sold</b>   ${usd(ledger.totalSoldUsd)}`,
        `<b>Holds</b>  ${compact(ledger.balanceTokens)} ${esc(sym)} ${ICON.bullet} ${pct(holdPct, 2)}`,
      ].join('\n'),
    ),
    '',
    `${pnl(ledger.totalPnlUsd)} ${ICON.bullet} ${positionBadge(ledger)}`,
    `<code>realized  ${esc(usd(ledger.realizedUsd, { sign: true }))}</code>`,
    `<code>unrealzd  ${esc(usd(ledger.unrealizedUsd, { sign: true }))}</code>`,
    '',
    `<b>Peak while holding</b> ${mult(ledger.heldMultiple)}`,
    ledger.realizedMultiple > 0 ? `<b>Realized</b> ${mult(ledger.realizedMultiple)}` : null,
    `<b>Now</b> ${mult(ledger.currentMultiple)} vs entry`,
    '',
    `<i>${ledger.buyCount} buys ${ICON.bullet} ${ledger.sellCount} sells ${ICON.bullet} ${esc(holdSummary(ledger))}</i>`,
    `<i>first buy ${ago(ledger.firstBuyTs)}</i>`,
  ].filter((l): l is string => l !== null);

  if (ledger.receivedTokens > 0 || ledger.sentTokens > 0) {
    lines.push('');
    lines.push(
      expandable(
        `${ICON.link} <b>Off-market movement</b>\n` +
          `received ${compact(ledger.receivedTokens)} ${esc(sym)}\n` +
          `sent ${compact(ledger.sentTokens)} ${esc(sym)}\n` +
          `<i>Tokens moved by transfer rather than bought or sold. Cost basis treats these as zero-cost.</i>`,
      ),
    );
  }

  // Lifetime record across every token, which is what says whether this wallet
  // is worth following or just caught one runner.
  const smart = report.smartMoney[ledger.wallet];
  if (smart && smart.tier !== 'unknown') {
    lines.push('');
    lines.push(`${smartBadge(smart)}  <i>across all tokens</i>`);
    lines.push(
      quote(
        [
          `<b>Lifetime PnL</b> ${usd(smart.totalPnlUsd, { sign: true })} on ${usd(smart.totalInvestedUsd)} invested`,
          `<b>Record</b> ${smart.wins}W / ${smart.losses}L ${ICON.bullet} ${pct(smart.winPercentage, 1)} win rate`,
          `<i>A low win rate is normal here — a few large winners routinely outweigh many small losses.</i>`,
        ].join('\n'),
      ),
    );
  }

  lines.push('');
  lines.push(walletFooter(chain, ledger.wallet));
  return clampMessage(lines.join('\n'));
}

// --- Risk detail -------------------------------------------------------------

export function renderRisk(report: AnalysisReport): string {
  const v = computeVerdict(report);
  const lines = [
    `${v.icon} <b>RISK ${v.risk}</b> ${ICON.bullet} <b>${v.band}</b>`,
    `<i>$${esc(report.token.symbol.trim().toUpperCase())}</i>`,
    '',
  ];

  if (v.factors.length > 0) {
    lines.push('<b>Adds risk</b>');
    lines.push(
      v.factors.map((f) => `+${f.weight}  <b>${esc(f.label)}</b>\n     <i>${esc(f.detail)}</i>`).join('\n'),
    );
    lines.push('');
  }
  if (v.positives.length > 0) {
    lines.push('<b>Reduces risk</b>');
    lines.push(
      v.positives.map((f) => `${f.weight}  <b>${esc(f.label)}</b>\n     <i>${esc(f.detail)}</i>`).join('\n'),
    );
    lines.push('');
  }
  if (v.factors.length === 0 && v.positives.length === 0) {
    lines.push('<i>Nothing scored either way — coverage was too thin to judge.</i>');
    lines.push('');
  }

  lines.push(
    quote(
      'This score is inference from on-chain behaviour, not a verdict on intent. Weightings are heuristics — read the underlying findings before acting on it.',
    ),
  );
  return clampMessage(lines.join('\n'));
}

// --- Copy list ---------------------------------------------------------------

/** Plain address list, formatted for pasting into a wallet tracker. */
export function renderCopyList(report: AnalysisReport, which: 'floor' | 'diamond' | 'dev' | 'relay'): string {
  const addresses = (() => {
    switch (which) {
      case 'floor':
        return report.floorEntries.map((e) => e.ledger.wallet);
      case 'diamond':
        return report.diamondHands.map((d) => d.ledger.wallet);
      case 'dev':
        return [report.devWallet, ...report.linkedWallets.map((l) => l.wallet)].filter(
          (w): w is string => Boolean(w),
        );
      case 'relay':
        return report.supplyRelays.flatMap((r) => [r.source, r.sink]);
    }
  })();

  const unique = [...new Set(addresses)].slice(0, 100);
  const label = { floor: 'Floor entries', diamond: 'Diamond hands', dev: 'Dev cluster', relay: 'Relay wallets' }[which];

  if (unique.length === 0) return `<i>Nothing to copy for ${esc(label)}.</i>`;

  return [
    `📋 <b>${esc(label)}</b> <i>· ${unique.length} addresses</i>`,
    '',
    `<pre>${unique.map(esc).join('\n')}</pre>`,
    '<i>Tap the block to copy all of them.</i>',
  ].join('\n');
}

// --- Watchlist ---------------------------------------------------------------

/**
 * A tracked wallet just bought something.
 *
 * Convergence changes the whole message rather than adding a line to it: two
 * independently chosen wallets landing on the same token is a different claim
 * from one wallet buying, and burying that under an identical header would
 * waste the only alert worth interrupting someone for.
 */
export function renderBuyAlert(a: {
  wallet: string;
  mint: string;
  symbol: string;
  name: string;
  tokenAmount: number;
  solSpent: number;
  usdSpent: number;
  mcapUsd: number;
  note: string;
  signature: string;
  freezeAuthorityActive?: boolean;
  mintAuthorityActive?: boolean;
  convergence?: { wallets: string[]; totalSolSpent: number; firstTs: number } | null;
  kind?: 'buy' | 'sell' | 'transfer-in' | 'transfer-out';
}): string {
  const sym = esc(a.symbol.trim().toUpperCase());
  const conv = a.convergence;
  // The verb has to match what happened. A watcher following sells that reads
  // "bought" is worse than no alert at all — it says the opposite of the truth.
  const kind = a.kind ?? 'buy';
  const VERB = {
    buy: { icon: '🔔', word: 'bought' },
    sell: { icon: '🔻', word: 'sold' },
    'transfer-in': { icon: '📥', word: 'received' },
    'transfer-out': { icon: '📤', word: 'sent out' },
  }[kind];

  const header = conv
    ? [
        `🎯🎯 <b>${conv.wallets.length} TRACKED WALLETS</b> bought <b>$${sym}</b>`,
        '',
        `<i>Converging over ${duration(Math.max(0, Math.floor(Date.now() / 1000) - conv.firstTs))} ${ICON.bullet} ${conv.totalSolSpent.toFixed(2)} SOL between them</i>`,
      ]
    : [`${VERB.icon} <b>${esc(shortAddr(a.wallet, 4, 4))}</b> ${VERB.word} <b>$${sym}</b>`];

  const size = `<code>${esc(`${a.solSpent.toFixed(3)} SOL`)}</code>${
    a.usdSpent > 0 ? ` ${ICON.bullet} ${usd(a.usdSpent)}` : ''
  }`;

  // Only ever stated as a live risk, never as an all-clear: Jupiter reporting
  // nothing means unknown, not safe.
  const flags = [
    a.freezeAuthorityActive ? '🧊 freeze authority is live — holders can be blocked from selling' : '',
    a.mintAuthorityActive ? '🖨 mint authority is live — supply can still be inflated' : '',
  ].filter(Boolean);

  const lines = [
    ...header,
    '',
    size,
    a.mcapUsd > 0 ? `at ${usd(a.mcapUsd)} market cap` : '',
    ...(flags.length ? ['', ...flags.map((f) => `${ICON.warn} ${f}`)] : []),
    '',
    `<i>${esc(a.name)}</i>`,
    `<code>${esc(a.mint)}</code>`,
    '',
    conv
      ? `<i>${conv.wallets.map((w) => esc(shortAddr(w, 4, 4))).join(' · ')}</i>`
      : `<i>${esc(a.note)}</i>`,
    `<a href="${walletUrl('solana', a.wallet)}">Wallet</a> ${ICON.bullet} <a href="${txUrl('solana', a.signature)}">Transaction</a> ${ICON.bullet} <a href="${dexScreenerUrl('solana', a.mint)}">Chart</a>`,
  ].filter((l) => l !== '');

  return clampMessage(lines.join('\n'));
}

/** The user's tracked wallets. */
const WATCH_FILTER_LABEL: Record<string, string> = {
  buys: '🟢 buys',
  sells: '🔴 sells',
  transfers: '📤 transfers',
  all: '⚡ everything',
};

export function renderWatchlist(
  entries: { wallet: string; note: string; addedAt: number; filter?: string }[],
): string {
  if (entries.length === 0) {
    return [
      heading('📌', 'WATCHLIST'),
      '',
      quote(
        'Nothing tracked yet. Open any wallet from a scan and tap Track, and you will be told when it buys something new.',
      ),
    ].join('\n');
  }
  const rows = entries
    .map(
      (e, i) =>
        `${rankBadge(i)} <a href="${walletUrl('solana', e.wallet)}">${esc(shortAddr(e.wallet, 4, 4))}</a>\n` +
        // The filter is shown because it decides whether silence means "no
        // activity" or "activity you asked not to hear about".
        `   <i>${esc(e.note)} ${ICON.bullet} ${esc(WATCH_FILTER_LABEL[e.filter ?? 'buys'] ?? 'buys')} ${ICON.bullet} added ${ago(e.addedAt)}</i>`,
    )
    .join('\n\n');
  return clampMessage(
    [heading('📌', 'WATCHLIST', `${entries.length} wallets`), '', rows].join('\n'),
  );
}
