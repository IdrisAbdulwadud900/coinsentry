import type { Logger } from "pino";
import type { LogSource } from "./data/logSource.js";
import type { RpcClient } from "./data/rpc.js";

/** Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface LaunchQuality {
  /** Share of total supply (0-100) taken by the single largest early buyer. */
  topBuyerPct: number | null;
  /** Combined share of total supply (0-100) taken by the top 5 early buyers. */
  top5Pct: number | null;
  /** Distinct wallets that bought out of the pool inside the window. */
  buyerCount: number;
  /** Transfers back into the pool inside the window — i.e. somebody sold. */
  sellCount: number;
  windowBlocks: number;
}

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/**
 * Reads a token's own Transfer events over the first `windowBlocks` after launch
 * and derives two signals that need no third-party indexer:
 *
 *  - **Bundle concentration** — the share of supply taken by the largest early
 *    buyers, counting only transfers *out of the pool* (real DEX buys), which
 *    excludes wallet-to-wallet moves and the initial LP mint. This is the same
 *    measure pons-revival-bot gates on.
 *  - **Sell evidence** — whether anything ever went back *into* the pool. Buys
 *    with zero sells across a meaningful sample is the classic honeypot shape.
 *
 * Returns null only when the data genuinely can't support a verdict (log query
 * failed, no buys at all, or a non-positive total supply). Percentages are never
 * fabricated: a null here must gate the alert rather than pass it.
 */
export async function assessLaunchQuality(
  logSource: LogSource,
  rpc: RpcClient,
  tokenAddress: string,
  poolAddress: string,
  launchBlock: bigint,
  windowBlocks: number,
  logger: Logger
): Promise<LaunchQuality | null> {
  const pool = poolAddress.toLowerCase();
  try {
    const totalSupplyHex = await rpc.ethCall(tokenAddress, SELECTOR_TOTAL_SUPPLY);
    const totalSupply = totalSupplyHex && totalSupplyHex !== "0x" ? BigInt(totalSupplyHex) : 0n;
    if (totalSupply <= 0n) return null;

    const logs = await logSource.getLogsForAddress(
      tokenAddress,
      launchBlock,
      launchBlock + BigInt(windowBlocks),
      TRANSFER_TOPIC
    );

    const boughtByWallet = new Map<string, bigint>();
    let sellCount = 0;

    for (const log of logs) {
      if (log.topics.length < 3) continue;
      const from = topicToAddress(log.topics[1]!);
      const to = topicToAddress(log.topics[2]!);
      const value = log.data && log.data !== "0x" ? BigInt(log.data.slice(0, 66)) : 0n;

      if (to === pool && from !== ZERO_ADDRESS) {
        sellCount += 1;
        continue;
      }
      if (from !== pool || to === ZERO_ADDRESS) continue;
      boughtByWallet.set(to, (boughtByWallet.get(to) ?? 0n) + value);
    }

    if (boughtByWallet.size === 0) return null;

    const sorted = [...boughtByWallet.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    const top1 = sorted[0] ?? 0n;
    const top5 = sorted.slice(0, 5).reduce((sum, v) => sum + v, 0n);

    return {
      topBuyerPct: (Number(top1) / Number(totalSupply)) * 100,
      top5Pct: (Number(top5) / Number(totalSupply)) * 100,
      buyerCount: boughtByWallet.size,
      sellCount,
      windowBlocks,
    };
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "Launch quality assessment failed");
    return null;
  }
}

export interface QualityLimits {
  maxTop5Pct: number;
  honeypotMinBuyers: number;
}

/**
 * Verdict on a quality reading. Returns a skip reason, or null to allow the
 * alert. An unavailable reading is a skip, not a pass — the whole point of the
 * gate is that a channel never publishes an unvetted launch.
 */
export function qualityBlockReason(
  quality: LaunchQuality | null,
  limits: QualityLimits
): string | null {
  if (!quality) return "quality-unknown";
  if (quality.top5Pct !== null && quality.top5Pct > limits.maxTop5Pct) {
    return `bundled: top-5 hold ${quality.top5Pct.toFixed(0)}% of supply (cap ${limits.maxTop5Pct}%)`;
  }
  // Zero sells only means something once enough wallets have bought that
  // somebody would plausibly have tried to exit; below that it's just quiet.
  if (quality.buyerCount >= limits.honeypotMinBuyers && quality.sellCount === 0) {
    return `possible honeypot: ${quality.buyerCount} buyers, zero sells`;
  }
  return null;
}
