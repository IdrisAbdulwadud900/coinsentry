import type { Logger } from "pino";
import type { LogSource, RawLog } from "./data/logSource.js";

export const TOPIC_V2_PAIR_CREATED =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const TOPIC_V3_POOL_CREATED =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

export type LaunchKind = "launchpad" | "amm-v2" | "amm-v3";

export interface DiscoveredLaunch {
  tokenAddress: string;
  quoteAddress: string;
  poolAddress: string;
  factory: string;
  kind: LaunchKind;
  blockNumber: bigint;
  txHash: string;
}

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/**
 * Decodes a factory event into a launch, deciding which side is the tradable
 * token: the token is whichever side isn't a configured quote asset. A pool
 * with no quote side at all is still reported (token0 treated as the token) so
 * the gate can reject it by reason rather than it vanishing here — such pairs
 * are usually token-token farms rather than launches.
 */
function decodeLog(
  log: RawLog,
  topic0: string,
  quoteTokens: Set<string>,
  v2Factories: Set<string>,
  v3Factories: Set<string>
): DiscoveredLaunch | null {
  if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== topic0) return null;
  const token0 = topicToAddress(log.topics[1]!);
  const token1 = topicToAddress(log.topics[2]!);
  const isV3 = topic0 === TOPIC_V3_POOL_CREATED;

  if (isV3 && !v3Factories.has(log.address)) return null;
  if (!isV3 && !v2Factories.has(log.address)) return null;

  const raw = log.data.slice(2);
  // V2 PairCreated data: (address pair, uint256 allPairsLength).
  // V3 PoolCreated data: (int24 tickSpacing, address pool).
  const poolWord = isV3 ? raw.slice(64, 128) : raw.slice(0, 64);
  if (poolWord.length !== 64) return null;
  const poolAddress = ("0x" + poolWord.slice(-40)).toLowerCase();

  const tokenAddress = quoteTokens.has(token0) ? token1 : token0;
  const quoteAddress = tokenAddress === token0 ? token1 : token0;

  // The launchpad factory emits PairCreated where the "pair" is the token
  // contract itself (an embedded bonding curve), which distinguishes a
  // launchpad mint from a regular AMM listing of an existing token.
  const kind: LaunchKind = isV3 ? "amm-v3" : poolAddress === tokenAddress ? "launchpad" : "amm-v2";

  return {
    tokenAddress,
    quoteAddress,
    poolAddress,
    factory: log.address,
    kind,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

export interface DiscoveryParams {
  logSource: LogSource;
  quoteTokens: Set<string>;
  v2Factories: string[];
  v3Factories: string[];
  fromBlock: bigint;
  toBlock: bigint;
  chunkBlocks: number;
  logger: Logger;
}

/**
 * Scans [fromBlock, toBlock] for factory events in chunks sized to stay under
 * the backend's response cap. A chunk that comes back at the cap is treated as
 * possibly truncated and re-scanned in quarter-size sub-chunks rather than
 * silently accepted, since a truncated window would hide launches that the
 * cursor is about to advance past.
 */
export async function scanRange(params: DiscoveryParams): Promise<DiscoveredLaunch[]> {
  const { logSource, quoteTokens, v2Factories, v3Factories, fromBlock, toBlock, chunkBlocks, logger } =
    params;
  const v2Set = new Set(v2Factories);
  const v3Set = new Set(v3Factories);
  const launches: DiscoveredLaunch[] = [];

  async function scanChunk(from: bigint, to: bigint, topic0: string, depth: number): Promise<void> {
    const logs = await logSource.getLogs(from, to, topic0);
    if (logs.length >= logSource.maxRecords && depth < 6 && to > from) {
      const quarter = (to - from) / 4n + 1n;
      logger.warn(
        { from: from.toString(), to: to.toString(), topic0, cap: logSource.maxRecords },
        "Chunk hit the backend response cap, re-scanning in sub-chunks"
      );
      let start = from;
      while (start <= to) {
        const end = start + quarter - 1n > to ? to : start + quarter - 1n;
        await scanChunk(start, end, topic0, depth + 1);
        start = end + 1n;
      }
      return;
    }
    for (const log of logs) {
      const launch = decodeLog(log, topic0, quoteTokens, v2Set, v3Set);
      if (launch) launches.push(launch);
    }
  }

  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + BigInt(chunkBlocks) - 1n > toBlock ? toBlock : start + BigInt(chunkBlocks) - 1n;
    await scanChunk(start, end, TOPIC_V2_PAIR_CREATED, 0);
    await scanChunk(start, end, TOPIC_V3_POOL_CREATED, 0);
    start = end + 1n;
  }

  launches.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  return launches;
}
