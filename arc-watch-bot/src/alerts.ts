import type { LaunchKind, DiscoveredLaunch } from "./discovery.js";
import type { BlockscoutClient } from "./data/blockscout.js";
import type { LaunchRow } from "./data/db.js";
import type { LaunchQuality } from "./quality.js";

export interface EnrichedLaunch extends DiscoveredLaunch {
  symbol: string | null;
  name: string | null;
  /** Pool liquidity in whole units of the quote asset, not USD. */
  liquidityQuote: number | null;
  quoteSymbol: string | null;
  deployer: string | null;
  deployerLaunchCount: number;
  verified: boolean | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KIND_LABEL: Record<string, string> = {
  launchpad: "🚀 Launchpad curve",
  "amm-v2": "💧 New V2 pool",
  "amm-v3": "💠 New V3 pool",
};

/** Bundle line, coloured by severity the way pons-revival-bot does it. */
function bundleLine(quality: LaunchQuality | null): string | null {
  if (!quality || quality.top5Pct === null) return null;
  const pct = quality.top5Pct;
  const icon = pct >= 50 ? "🚨" : pct >= 30 ? "⚠️" : "🫧";
  const top1 = quality.topBuyerPct === null ? "" : ` / ${quality.topBuyerPct.toFixed(0)}% top-1`;
  return `${icon} Bundle: <b>${pct.toFixed(0)}% top-5</b>${top1} <i>(first ${quality.windowBlocks} blocks)</i>`;
}

function sellLine(quality: LaunchQuality | null): string | null {
  if (!quality) return null;
  return `🔁 Early trades: <b>${quality.buyerCount}</b> buyers, <b>${quality.sellCount}</b> sells`;
}

export function formatLaunchAlert(
  row: LaunchRow,
  quality: LaunchQuality | null,
  deployerLaunchCount: number,
  blockscout: BlockscoutClient
): string {
  const symbol = row.symbol ? `$${esc(row.symbol)}` : "?";
  const name = row.name ? esc(row.name) : "Unknown";
  const liq =
    row.liquidity_quote === null
      ? "unknown"
      : `${row.liquidity_quote.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(row.quote_symbol ?? "")}`.trim();
  const verified =
    row.verified === null ? "lookup failed" : row.verified ? "✅ verified" : "⚠️ unverified";
  const deployerNote =
    deployerLaunchCount > 1 ? ` (${deployerLaunchCount} launches from this wallet)` : "";

  const lines: (string | null)[] = [
    `<b>${KIND_LABEL[row.kind] ?? row.kind}</b>`,
    ``,
    `<b>${symbol}</b> — ${name}`,
    `<code>${row.token_address}</code>`,
    ``,
    `💰 Liquidity: <b>${liq}</b>`,
    bundleLine(quality),
    sellLine(quality),
    `📄 Contract: ${verified}`,
    row.deployer
      ? `👤 Deployer: <a href="${blockscout.addressUrl(row.deployer)}">${row.deployer.slice(0, 10)}…</a>${deployerNote}`
      : `👤 Deployer: unknown`,
    ``,
    `<a href="${blockscout.tokenUrl(row.token_address)}">Token</a> · <a href="${blockscout.addressUrl(row.pool_address)}">Pool</a> · <a href="${blockscout.txUrl(row.tx_hash)}">Launch tx</a>`,
    ``,
    `<i>Unverified contracts on a chain with no third-party coverage are maximum-risk. Never trade more than you can lose entirely.</i>`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export type { LaunchKind };
