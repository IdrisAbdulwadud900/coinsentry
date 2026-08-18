import type { AnalysisReport } from '../../types/domain.js';
import { computeVerdict } from '../../engine/verdict.js';
import { summariseSmartMoney } from '../../engine/smartMoney.js';
import {
  esc,
  usd,
  compact,
  count,
  mult,
  sparkline,
  ago,
  shortAddr,
  dexScreenerUrl,
  tokenUrl,
  padEnd,
} from '../../util/format.js';
import { CHAIN_BADGE, ICON, meter, quote, expandable } from '../ui.js';

/**
 * The landing card. Everything a trader needs to decide whether to dig in,
 * above the fold: what it is, what it's worth, whether it looks hostile, and
 * how much there is to look at.
 */
export function renderOverview(report: AnalysisReport): string {
  const t = report.token;
  const v = computeVerdict(report);
  const lines: string[] = [];

  // --- Identity -------------------------------------------------------------
  const title = `${ICON.brand} <b>XRAY</b> ${ICON.bullet} <b>$${esc(t.symbol.trim().toUpperCase())}</b>`;
  lines.push(title);

  const provenance = [
    CHAIN_BADGE[t.chain],
    t.launchpad ? esc(t.launchpad) : null,
    t.dexId ? esc(t.dexId) : null,
  ]
    .filter(Boolean)
    .join(` ${ICON.bullet} `);
  lines.push(`<i>${provenance}</i>`);
  lines.push('');

  // --- Market snapshot ------------------------------------------------------
  lines.push(
    [
      `${ICON.money} <b>${usd(t.mcap)}</b>`,
      `${ICON.liquidity} ${usd(t.liquidityUsd)}`,
      t.holderCount ? `${ICON.holders} ${compact(t.holderCount, 0)}` : null,
    ]
      .filter(Boolean)
      .join(`  ${ICON.bullet}  `),
  );

  const spark = sparkline(report.mcapSeries, 22);
  if (spark) {
    const runFromFloor = report.floorMcap > 0 ? t.mcap / report.floorMcap : 0;
    lines.push(`<code>${spark}</code>`);
    // It is a real floor when the scan reached the launch, or when the coin's
    // launchpad fixes the opening price. Otherwise it is only a window low.
    const floorKnown = report.reachedLaunch || report.floorSource === 'launchpad';
    const floorLabel = report.floorSource === 'launchpad' ? 'launch' : floorKnown ? 'floor' : 'window low';
    lines.push(
      `<i>${floorLabel} ${usd(report.floorMcap)} ${ICON.arrow} now ${usd(t.mcap)}${
        runFromFloor > 1 && floorKnown ? `  (${mult(runFromFloor)})` : ''
      }</i>`,
    );
  }
  lines.push('');

  // --- Verdict --------------------------------------------------------------
  lines.push(`${v.icon} <b>RISK ${v.risk}</b> ${ICON.bullet} <b>${v.band}</b>`);
  lines.push(meter(v.risk, 12));
  const topFactors = [...v.factors.slice(0, 3), ...v.positives.slice(0, 1)];
  if (topFactors.length > 0) {
    lines.push(
      quote(
        topFactors
          .map((f) => `${f.weight > 0 ? '•' : '✓'} ${esc(f.detail)}`)
          .join('\n'),
      ),
    );
  }
  lines.push('');

  // --- Findings table -------------------------------------------------------
  // On a token too busy to replay, the provider records ARE the finding. The
  // summary must count what the buttons will actually open, or the card
  // reports zero next to a button offering 82 wallets.
  const useProviderEntries = !report.reachedLaunch && report.providerEntries.length > 0;
  const useProviderDiamond =
    report.diamondHands.length === 0 && report.providerDiamondHands.length > 0;

  const entryLabel = useProviderEntries ? 'First buyers' : 'Floor entries';
  const entryCount = useProviderEntries
    ? report.providerEntries.length
    : report.floorEntries.length;

  const diamondList = useProviderDiamond ? report.providerDiamondHands : report.diamondHands;
  const holdingCount = useProviderDiamond
    ? report.providerDiamondHands.filter((e) => e.stillHolding).length
    : report.diamondHands.filter((d) => d.ledger.stillHolding).length;
  const strongRelays = report.supplyRelays.filter((r) => r.suspicion >= 60).length;
  const rows: [string, string, string][] = [
    [ICON.floor, entryLabel, `${entryCount} wallets`],
    [
      ICON.diamond,
      'Diamond hands',
      `${diamondList.length}${holdingCount ? ` (${holdingCount} holding)` : ''}`,
    ],
    [ICON.dev, 'Dev cluster', report.devWallet ? `${report.linkedWallets.length} linked` : 'unknown'],
    [
      ICON.relay,
      'Supply relays',
      report.supplyRelays.length === 0
        ? 'none'
        : `${report.supplyRelays.length}${strongRelays ? ` (${strongRelays} strong)` : ''}`,
    ],
  ];
  lines.push(
    rows.map(([icon, label, value]) => `${icon} <code>${esc(padEnd(label, 15))}</code>${esc(value)}`).join('\n'),
  );
  lines.push('');

  // --- Smart money ----------------------------------------------------------
  const smart = summariseSmartMoney(Object.values(report.smartMoney));
  if (smart.rated > 0) {
    lines.push(
      smart.smart > 0
        ? `🏆 <b>${smart.smart}/${smart.rated}</b> early wallets are proven profitable ${ICON.bullet} <i>${usd(smart.combinedPnlUsd)} lifetime PnL between them</i>`
        : `<i>None of the ${smart.rated} early wallets checked have a profitable record elsewhere.</i>`,
    );
    lines.push('');
  }

  // --- Coverage -------------------------------------------------------------
  const coverage = [
    `${count(report.tradeCount)} trades`,
    `${count(report.uniqueWallets)} wallets`,
    report.firstTradeTs ? `first trade ${ago(report.firstTradeTs)}` : null,
  ]
    .filter(Boolean)
    .join(` ${ICON.bullet} `);
  lines.push(`<i>${esc(coverage)}</i>`);

  // --- Caveats --------------------------------------------------------------
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(
      expandable(
        `${ICON.warn} <b>Coverage notes</b>\n${report.warnings.map((w) => `• ${esc(w)}`).join('\n')}`,
      ),
    );
  }

  lines.push('');
  lines.push(
    `<a href="${dexScreenerUrl(t.chain, t.pairAddress ?? t.address)}">Chart</a> ${ICON.bullet} ` +
      `<a href="${tokenUrl(t.chain, t.address)}">Token</a> ${ICON.bullet} ` +
      `<code>${esc(shortAddr(t.address, 6, 6))}</code>`,
  );

  return lines.join('\n');
}
