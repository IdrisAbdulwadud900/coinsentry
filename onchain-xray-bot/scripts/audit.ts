/**
 * Cross-checks the bot's own numbers against independent sources.
 *
 *   npm run audit -- <contract-address>
 *
 * Every figure here is one the bot computes AND some other party publishes, so
 * the two can be compared without trusting either. That is the whole point:
 * unit tests prove the code does what it was written to do, and say nothing
 * about whether the answer is true. These checks have caught two real bugs that
 * a green test suite did not — a peak inflated 66% by a single bad print, and a
 * peak silently halved when a candle fetch failed.
 *
 * A FAIL here is a bug in the bot. A WARN is usually missing coverage, which is
 * worth knowing but is not the same thing.
 */
import { analyzeToken } from '../src/engine/analyze.js';
import { lookupToken } from '../src/data/dexscreener.js';
import { fetchCandleSeries, CandleIndex } from '../src/data/ohlcv.js';
import { SolanaTrackerClient } from '../src/data/solanatracker.js';

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

const results: { status: Status; name: string; detail: string }[] = [];
const record = (status: Status, name: string, detail: string) =>
  results.push({ status, name, detail });

const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Within `tolerance` as a ratio, in either direction. */
function agrees(a: number, b: number, tolerance: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi / lo <= tolerance;
}

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address) {
    console.error('usage: npm run audit -- <contract-address>');
    process.exit(1);
  }

  console.error('Scanning…');
  const report = await analyzeToken(address, async () => {});
  const ds = await lookupToken(address);
  const supply = report.token.totalSupply;

  console.error(`\n$${report.token.symbol} on ${report.token.chain}\n`);

  // --- Supply -------------------------------------------------------------
  // A wrong supply scales every market cap in the report silently.
  const dsPrice = ds ? ds.best.priceUsd : 0;
  const dsMcap = ds ? ds.best.mcap : 0;
  if (dsPrice > 0 && dsMcap > 0 && supply > 0) {
    const implied = dsMcap / dsPrice;
    record(
      agrees(supply, implied, 1.05) ? 'PASS' : 'FAIL',
      'total supply',
      `ours ${supply.toExponential(4)} vs DexScreener-implied ${implied.toExponential(4)}`,
    );
  } else {
    record('SKIP', 'total supply', 'no DexScreener price/mcap to imply it from');
  }

  // --- Current market cap -------------------------------------------------
  const ourMcap = report.mcapSeries[report.mcapSeries.length - 1] ?? 0;
  if (dsMcap > 0 && ourMcap > 0) {
    record(
      agrees(ourMcap, dsMcap, 1.15) ? 'PASS' : 'FAIL',
      'current market cap',
      `ours ${usd(ourMcap)} vs DexScreener ${usd(dsMcap)}`,
    );
  } else {
    record('SKIP', 'current market cap', 'not available on both sides');
  }

  // --- Peak and floor against the chart -----------------------------------
  if (ds && supply > 0) {
    const series = await fetchCandleSeries(
      report.token.chain,
      ds.best.pairAddress,
      report.token.createdAt,
      report.token.address,
    );
    if (series.candles.length === 0) {
      record('WARN', 'peak vs chart', 'no candles available to compare against');
    } else {
      const idx = new CandleIndex(series);
      const chartHigh = idx.high * supply;
      const chartLow = idx.floor * supply;

      // A peak is a maximum, so one bad print can set it however sound the
      // rest are. It must not sit far above what the chart ever showed.
      record(
        report.peakMcap <= chartHigh * 1.3 ? 'PASS' : 'FAIL',
        'peak vs chart',
        `ours ${usd(report.peakMcap)} vs chart high ${usd(chartHigh)}`,
      );

      // A peak below today's price cannot be an all-time high.
      if (ourMcap > 0) {
        record(
          report.peakMcap >= ourMcap * 0.95 ? 'PASS' : 'FAIL',
          'peak covers today',
          `peak ${usd(report.peakMcap)} vs current ${usd(ourMcap)}`,
        );
      }

      // The floor is a minimum, so the same one-bad-print risk applies — but
      // the number to check is the one the report actually uses. The raw
      // lowest print can legitimately be a sell no buyer could reach, and the
      // entry band is already rebased off it for exactly that reason.
      const candlesReachLaunch =
        report.token.createdAt !== null && series.coversFrom <= report.token.createdAt + 3 * 3600;
      const floorUsed = report.entryBandMin > 0 ? report.entryBandMin : report.floorMcap;

      // A launchpad floor is a published constant — pump.fun opens every coin
      // at a fixed 28 SOL — and beats candles outright, because the indexed
      // pool only exists AFTER graduation and never saw the bonding curve at
      // all. Comparing the two flagged a correct $2,197 against a $27,845
      // chart low that starts thousands of percent later.
      if (report.floorSource === 'launchpad') {
        record(
          'PASS',
          'floor vs chart',
          `${usd(floorUsed)} from the launchpad's fixed opening price, which candles cannot see`,
        );
      } else if (candlesReachLaunch && floorUsed > 0 && chartLow > 0) {
        record(
          agrees(floorUsed, chartLow, 1.5) ? 'PASS' : 'WARN',
          'floor vs chart',
          `band starts ${usd(floorUsed)} vs chart low ${usd(chartLow)}` +
            (report.entryBandRebased ? ' (rebased off a sell)' : ''),
        );
      } else {
        record('SKIP', 'floor vs chart', 'candles do not reach the launch');
      }
    }
  }

  // --- Solana entry prices ------------------------------------------------
  // The provider's first-buyer records drive every Solana entry figure, so a
  // wrong one poisons the floor list, the tiers and every multiple.
  const tracker = SolanaTrackerClient.fromConfig();
  if (report.token.chain === 'solana' && tracker && ds && supply > 0) {
    const series = await fetchCandleSeries(
      'solana',
      ds.best.pairAddress,
      report.token.createdAt,
      report.token.address,
    );
    const idx = new CandleIndex(series);
    const buyers = await tracker.firstBuyers(report.token.address);
    let checked = 0;
    let impossible = 0;
    for (const b of buyers) {
      if (!b.firstBuyTs || !b.entryTokens || !b.entryUsd) continue;
      const entryMcap = (b.entryUsd / b.entryTokens) * supply;
      // Wide enough to contain whichever candle period covers the moment.
      const windowHigh = idx.peak(b.firstBuyTs - 172_800, b.firstBuyTs + 172_800) * supply;
      if (!(windowHigh > 0)) continue;
      checked++;
      if (entryMcap > windowHigh * 1.5) impossible++;
    }
    if (checked === 0) {
      record('SKIP', 'entry prices vs chart', 'no overlap between entries and candles');
    } else {
      record(
        impossible === 0 ? 'PASS' : 'FAIL',
        'entry prices vs chart',
        `${checked - impossible}/${checked} entries sit at or below what the chart showed`,
      );
    }
  }

  // --- Report -------------------------------------------------------------
  const icon: Record<Status, string> = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '·' };
  for (const r of results) {
    console.log(`${icon[r.status]} ${r.status.padEnd(4)} ${r.name.padEnd(24)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(
    `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ` +
      `${results.filter((r) => r.status === 'WARN').length} warned, ` +
      `${results.filter((r) => r.status === 'SKIP').length} skipped`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

await main();
