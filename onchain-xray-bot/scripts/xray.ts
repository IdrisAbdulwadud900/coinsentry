/**
 * CLI harness: runs the full analysis against a real contract and prints every
 * screen as it would appear in Telegram. Lets the pipeline and the rendering be
 * verified without a bot token.
 *
 *   npm run xray -- <contract-address>
 */
import { analyzeToken, AnalysisError } from '../src/engine/analyze.js';
import { rpcRequestCount } from '../src/data/evmPair.js';
import { renderOverview } from '../src/bot/render/overview.js';
import {
  renderFloorEntries,
  renderProviderEntries,
  renderProvenWinners,
  renderWinningPlay,
  renderDiamondHands,
  renderDevCluster,
  renderRelays,
  renderRisk,
  renderWallet,
} from '../src/bot/render/screens.js';

/** Approximates Telegram's rendering so the terminal shows what a user sees. */
function toText(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_m, url, label) => `${label} \x1b[2m(${url})\x1b[0m`)
    .replace(/<b>|<\/b>/g, '\x1b[1m'.length ? '' : '')
    .replace(/<b>/g, '\x1b[1m')
    .replace(/<\/b>/g, '\x1b[0m')
    .replace(/<i>/g, '\x1b[3m\x1b[2m')
    .replace(/<\/i>/g, '\x1b[0m')
    .replace(/<code>/g, '\x1b[36m')
    .replace(/<\/code>/g, '\x1b[0m')
    .replace(/<pre>/g, '\x1b[36m')
    .replace(/<\/pre>/g, '\x1b[0m')
    .replace(/<blockquote expandable>/g, '\x1b[2m│ ')
    .replace(/<blockquote>/g, '\x1b[2m│ ')
    .replace(/<\/blockquote>/g, '\x1b[0m')
    .replace(/\n(?=[^\n])/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function banner(title: string): void {
  console.log(`\n\x1b[7m ${title} \x1b[0m\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const deep = args.includes('--deep');
  const address = args.find((a) => !a.startsWith('--'));
  if (!address) {
    console.error('usage: npm run xray -- <contract-address> [--deep]');
    process.exit(1);
  }

  const started = Date.now();
  let lastStage = '';

  try {
    const report = await analyzeToken(address, (u) => {
      const line = `${u.stage}${u.detail ? ` — ${u.detail}` : ''}`;
      if (line !== lastStage) {
        lastStage = line;
        console.error(`\x1b[2m[${String(Math.round(u.pct * 100)).padStart(3)}%] ${line}\x1b[0m`);
      }
    }, { deep });

    console.error(
      `\x1b[2m\ncompleted in ${((Date.now() - started) / 1000).toFixed(1)}s · ${rpcRequestCount} EVM RPC requests\x1b[0m`,
    );

    banner('OVERVIEW');
    console.log(toText(renderOverview(report)));

    banner('FLOOR ENTRIES');
    console.log(toText(renderFloorEntries(report, 0, 'earliest')));

    if (report.provenWinners.length > 0 || report.winnersChecked > 0) {
      banner('PROVEN WINNERS');
      console.log(toText(renderProvenWinners(report, 0)));
    }

    banner('WINNING PLAY');
    console.log(toText(renderWinningPlay(report)));

    if (report.providerEntries.length > 0) {
      banner('FIRST BUYERS');
      console.log(toText(renderProviderEntries(report, 0)));
    }

    banner('DIAMOND HANDS');
    console.log(toText(renderDiamondHands(report, 0)));

    banner('DEV CLUSTER');
    console.log(toText(renderDevCluster(report, 0)));

    banner('SUPPLY RELAYS');
    console.log(toText(renderRelays(report, 0)));

    banner('RISK DETAIL');
    console.log(toText(renderRisk(report)));

    const sample = report.floorEntries[0]?.ledger ?? report.diamondHands[0]?.ledger;
    if (sample) {
      banner('WALLET DETAIL');
      console.log(toText(renderWallet(report, sample)));
    }

    banner('RAW STATS');
    console.log(
      JSON.stringify(
        {
          chain: report.token.chain,
          symbol: report.token.symbol,
          totalSupply: report.token.totalSupply,
          trades: report.tradeCount,
          wallets: report.uniqueWallets,
          floorMcap: report.floorMcap,
          peakMcap: report.peakMcap,
          floorEntries: report.floorEntries.length,
          diamondHands: report.diamondHands.length,
          linkedWallets: report.linkedWallets.length,
          supplyRelays: report.supplyRelays.length,
          truncated: report.truncated,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err instanceof AnalysisError) {
      console.error(`\n\x1b[31m${err.message}\x1b[0m${err.hint ? `\n${err.hint}` : ''}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

void main();
