import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import type { Logger } from "pino";

const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] as string[] } },
  contracts: {
    // Confirmed deployed at the standard address on Robinhood Chain.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}` },
  },
} as const;

export const TOKEN_LAUNCHED_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
);

const GRADUATION_STATUS_ABI = parseAbiItem(
  "function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)"
);

const SLOT0_ABI = parseAbiItem(
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
);

const DECIMALS_ABI = parseAbiItem("function decimals() view returns (uint8)");
const TOTAL_SUPPLY_ABI = parseAbiItem("function totalSupply() view returns (uint256)");
const NAME_ABI = parseAbiItem("function name() view returns (string)");
const SYMBOL_ABI = parseAbiItem("function symbol() view returns (string)");
const BALANCE_OF_ABI = parseAbiItem("function balanceOf(address) view returns (uint256)");
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TokenLaunchedLog {
  tokenAddress: string;
  deployerAddress: string | null;
  /** Uniswap V3 pool address for this token's pair, from the TokenLaunched event. */
  poolAddress: string | null;
  /** The token this one is paired against in its pool (WETH per Pons docs). */
  pairTokenAddress: string | null;
  blockNumber: bigint;
}

export interface GraduationStatusResult {
  tokenAddress: string;
  /** Which factory the successful call resolved against. Useful when a caller probes
   * multiple candidate factories per token (e.g. to determine a token's true origin),
   * since only the correct factory's call succeeds. */
  factoryAddress: string;
  pairedWei: bigint;
  thresholdWei: bigint;
  graduated: boolean;
}

/**
 * Shape of a single `graduationStatus` multicall result. viem infers `multicall`'s
 * return type from the literal shape of the `contracts` argument at the call site;
 * since `contracts` below is built dynamically via `.map()` over a runtime-sized
 * batch (not a fixed literal tuple), that inference degrades and `result` comes back
 * as `unknown`. This named type restores precision at that one trust boundary: every
 * contract in the batch shares `GRADUATION_STATUS_ABI`'s fixed return tuple, so the
 * cast is safe as long as the ABI string above stays in sync with it.
 */
type GraduationMulticallResult =
  | { status: "success"; result: readonly [bigint, bigint, boolean] }
  | { status: "failure"; error: Error };

export function createChainClient(rpcUrl: string) {
  return createPublicClient({
    chain: { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });
}

export type ChainClient = ReturnType<typeof createChainClient>;

const MAX_CHUNK_RETRIES = 3;
// Floor for range-bisection on persistent non-cap failures (e.g. RPC timeouts on
// otherwise-ordinary-sized ranges). Below this, we give up on the leaf range and let
// the caller (scanTokenLaunches) stop the cycle at the last successfully-scanned
// block rather than recursing indefinitely.
const MIN_BISECT_RANGE_BLOCKS = 2000n;

function isResultCountCapError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("logs matched by query exceeds limit");
}

async function getLogsWithRetry(
  client: ChainClient,
  factoryAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  logger: Logger
): Promise<Log[]> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= MAX_CHUNK_RETRIES) {
    try {
      return await client.getLogs({
        address: factoryAddress as `0x${string}`,
        event: TOKEN_LAUNCHED_EVENT,
        fromBlock,
        toBlock,
      });
    } catch (err) {
      lastErr = err;
      // The result-count cap (>10000 matching logs) is deterministic for this exact
      // range — retrying the same range can never succeed, so bail out immediately
      // and let the caller bisect the range instead of burning retries/backoff on it.
      if (isResultCountCapError(err)) break;
      if (attempt === MAX_CHUNK_RETRIES) break;
      const backoffMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
      logger.warn(
        { factoryAddress, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), attempt, backoffMs },
        "getLogs chunk failed (timeout or rate limit), retrying"
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      attempt += 1;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Fetches logs for [fromBlock, toBlock], recursively bisecting the range whenever
 * the RPC rejects it for matching more than its 10,000-result cap (immediately, since
 * that failure is deterministic for the exact range — retrying can never succeed).
 * Other failures (timeout/429/etc.) are retried with backoff at the current range size
 * first (via getLogsWithRetry); if they still persist after exhausting retries, the
 * range is bisected too rather than abandoned outright, down to a `MIN_BISECT_RANGE_BLOCKS`
 * floor — some RPC failures (e.g. "log query timed out") occur on perfectly ordinary
 * range sizes and are otherwise indistinguishable from genuine outages, so narrowing
 * the range is the only way to make forward progress on them.
 */
async function getLogsBisecting(
  client: ChainClient,
  factoryAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  logger: Logger
): Promise<Log[]> {
  try {
    return await getLogsWithRetry(client, factoryAddress, fromBlock, toBlock, logger);
  } catch (err) {
    const rangeSize = toBlock - fromBlock + 1n;
    if (fromBlock >= toBlock || rangeSize <= MIN_BISECT_RANGE_BLOCKS) {
      throw err;
    }
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    logger.warn(
      {
        factoryAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        mid: mid.toString(),
        reason: isResultCountCapError(err) ? "result-count-cap" : "persistent-failure",
      },
      "getLogs chunk failed, bisecting range"
    );
    const [left, right] = await Promise.all([
      getLogsBisecting(client, factoryAddress, fromBlock, mid, logger),
      getLogsBisecting(client, factoryAddress, mid + 1n, toBlock, logger),
    ]);
    return [...left, ...right];
  }
}

/**
 * Scans a factory contract for TokenLaunched events between fromBlock and the
 * current chain head, in bounded chunks (the public RPC times out on wide
 * eth_getLogs ranges and occasionally rate-limits with 429s). Each chunk is
 * retried with exponential backoff before giving up. Returns discovered token
 * addresses plus the block number the scan reached, so callers can persist a
 * resumable cursor.
 */
export async function scanTokenLaunches(
  client: ChainClient,
  factoryAddress: string,
  fromBlock: bigint,
  chunkSize: number,
  logger: Logger,
  /**
   * Ceiling on launches returned from one call. Without it this scan runs all the way to
   * the chain head and keeps every launch in one array: after the bot spent days offline
   * the backlog on a chain minting ~18.7k tokens a day was large enough to pin ~511MB of
   * live objects (GC logs showed Mark-Compact reclaiming nothing: 511.4 -> 511.2 MB) and
   * the process died on the heap limit every cycle, which kept it offline and made the
   * backlog worse. Stopping early and reporting the block actually reached turns catch-up
   * into steady progress across cycles instead of one allocation the VM cannot hold.
   */
  maxLaunches: number
): Promise<{ launches: TokenLaunchedLog[]; reachedBlock: bigint }> {
  const head = await client.getBlockNumber();
  const launches: TokenLaunchedLog[] = [];

  if (fromBlock > head) {
    return { launches, reachedBlock: head };
  }

  let cursor = fromBlock;
  const chunk = BigInt(chunkSize);
  let chunksScanned = 0;

  while (cursor <= head) {
    const toBlock = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
    try {
      const logs = await getLogsBisecting(client, factoryAddress, cursor, toBlock, logger);
      for (const log of logs) {
        const args = (
          log as unknown as {
            args: { token?: string; deployer?: string; pool?: string; pairToken?: string };
          }
        ).args;
        if (args?.token) {
          launches.push({
            tokenAddress: args.token,
            deployerAddress: args.deployer ?? null,
            poolAddress: args.pool ?? null,
            pairTokenAddress: args.pairToken ?? null,
            blockNumber: log.blockNumber ?? cursor,
          });
        }
      }
      if (launches.length >= maxLaunches) {
        logger.warn(
          { factoryAddress, found: launches.length, reachedBlock: toBlock.toString(), head: head.toString() },
          "Discovery hit its per-cycle launch cap, resuming from here next cycle"
        );
        return { launches, reachedBlock: toBlock };
      }

      chunksScanned += 1;
      if (chunksScanned % 5 === 0) {
        const totalRange = Number(head - fromBlock) || 1;
        const doneRange = Number(toBlock - fromBlock);
        logger.info(
          {
            factoryAddress,
            cursor: toBlock.toString(),
            head: head.toString(),
            found: launches.length,
            pctDone: ((doneRange / totalRange) * 100).toFixed(1),
          },
          "Discovery scan progress"
        );
      }
    } catch (err) {
      logger.error(
        { factoryAddress, fromBlock: cursor.toString(), toBlock: toBlock.toString(), err: String(err) },
        "getLogs chunk failed after retries, stopping scan for this cycle"
      );
      // Stop at the last successfully scanned block; caller persists this as the cursor
      // so the next cycle retries the failed chunk instead of skipping it.
      return { launches, reachedBlock: cursor - 1n < fromBlock ? fromBlock - 1n : cursor - 1n };
    }
    cursor = toBlock + 1n;
  }

  return { launches, reachedBlock: head };
}

const MAX_MULTICALL_RETRIES = 3;

/**
 * Batch-reads `graduationStatus(token)` on each token's originating factory via
 * multicall3 (confirmed deployed on Robinhood Chain at the standard address), in
 * chunks of `batchSize` to stay under RPC response-size limits. A chunk that fails
 * outright (after retries) is logged and skipped for this cycle rather than aborting
 * the whole sweep — it'll simply be retried on the next poll. Individual per-call
 * reverts within a successful multicall are skipped the same way (`allowFailure`).
 */
const POOL_TOKEN0_ABI = parseAbiItem("function token0() view returns (address)");
const POOL_TOKEN1_ABI = parseAbiItem("function token1() view returns (address)");

/**
 * Reads which two tokens each pool holds, so a swap log can be traced back to a coin.
 *
 * Swap logs name the pool, not the token. The bot knows the pool for only some coins —
 * 60,395 of its unindexed launchpad coins have one recorded and 129,553 do not — so
 * without this a coin whose pool was never recorded stays invisible no matter how hard it
 * is being bought. Resolving pools straight from the chain lets the bot learn the mapping
 * from the trading itself.
 *
 * Failures are skipped rather than thrown: a "pool" that is not a pool (any contract can
 * emit a matching topic) simply reverts, and that is expected, not exceptional.
 */
export async function readPoolTokens(
  client: ChainClient,
  poolAddresses: string[],
  batchSize: number,
  logger: Logger
): Promise<Map<string, { token0: string; token1: string }>> {
  const out = new Map<string, { token0: string; token1: string }>();
  for (let i = 0; i < poolAddresses.length; i += batchSize) {
    const batch = poolAddresses.slice(i, i + batchSize);
    const contracts = batch.flatMap((address) => [
      { address: address as `0x${string}`, abi: [POOL_TOKEN0_ABI], functionName: "token0" as const },
      { address: address as `0x${string}`, abi: [POOL_TOKEN1_ABI], functionName: "token1" as const },
    ]);
    try {
      const results = await client.multicall({ contracts, allowFailure: true });
      for (let j = 0; j < batch.length; j += 1) {
        const t0 = results[j * 2];
        const t1 = results[j * 2 + 1];
        if (t0?.status !== "success" || t1?.status !== "success") continue;
        out.set(batch[j]!.toLowerCase(), {
          token0: String(t0.result).toLowerCase(),
          token1: String(t1.result).toLowerCase(),
        });
      }
    } catch (err) {
      logger.warn({ err: String(err), batch: batch.length }, "Pool token resolution batch failed, skipping");
    }
  }
  return out;
}

export async function readGraduationStatuses(
  client: ChainClient,
  calls: { factoryAddress: string; tokenAddress: string }[],
  batchSize: number,
  logger: Logger
): Promise<GraduationStatusResult[]> {
  const results: GraduationStatusResult[] = [];

  for (let i = 0; i < calls.length; i += batchSize) {
    const batch = calls.slice(i, i + batchSize);
    const contracts = batch.map((c) => ({
      address: c.factoryAddress as `0x${string}`,
      abi: [GRADUATION_STATUS_ABI],
      functionName: "graduationStatus" as const,
      args: [c.tokenAddress as `0x${string}`] as const,
    }));

    let attempt = 0;
    let batchResults: Awaited<ReturnType<ChainClient["multicall"]>> | undefined;
    while (batchResults === undefined) {
      try {
        batchResults = await client.multicall({ contracts, allowFailure: true });
      } catch (err) {
        if (attempt >= MAX_MULTICALL_RETRIES) {
          logger.error(
            { err: String(err), batchSize: batch.length },
            "graduationStatus multicall batch failed after retries, skipping this batch for now"
          );
          break;
        }
        const backoffMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
        logger.warn({ err: String(err), attempt, backoffMs }, "graduationStatus multicall batch failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
      }
    }
    if (!batchResults) continue;

    for (let j = 0; j < batch.length; j += 1) {
      const result = batchResults[j] as GraduationMulticallResult | undefined;
      const call = batch[j];
      if (!result || !call || result.status !== "success") continue;
      const [pairedPrincipal, threshold, graduated] = result.result;
      results.push({
        tokenAddress: call.tokenAddress,
        factoryAddress: call.factoryAddress,
        pairedWei: pairedPrincipal,
        thresholdWei: threshold,
        graduated,
      });
    }
  }

  return results;
}

// pairToken is always WETH per Pons docs (every pool is paired against WETH), which is
// always 18 decimals — same as native ETH, since WETH wraps it 1:1.
const PAIR_TOKEN_DECIMALS = 18;

export interface PoolMarketCapInput {
  tokenAddress: string;
  poolAddress: string;
  pairTokenAddress: string;
  /** Cached decimals from a prior successful read, if known — skips the on-chain call. */
  tokenDecimals?: number | null;
  /** Cached raw totalSupply (string) from a prior successful read, if known — skips the call. */
  tokenTotalSupply?: string | null;
}

export interface PoolMarketCapResult {
  tokenAddress: string;
  priceUsd: number;
  marketCapUsd: number;
  decimals: number;
  /** Raw on-chain totalSupply, as a string (mirrors the existing *_wei string pattern). */
  totalSupply: string;
}

/**
 * Converts a Uniswap V3 `slot0().sqrtPriceX96` into the price of token0 denominated in
 * token1, in human (decimal-adjusted) units. Exported standalone for unit testing against
 * hand-computed vectors. Uses floating-point math deliberately — this is a display-only
 * figure (market cap in an alert message), not trade-execution math, so the precision
 * trade-off for simplicity is acceptable.
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawPrice1Per0 = ratio * ratio;
  return rawPrice1Per0 * 10 ** (decimals0 - decimals1);
}

/**
 * Batch-resolves real, on-chain market caps for tokens that don't (yet) have DexScreener
 * data — pre-index and ungraduated tokens. Every Pons token has a live Uniswap V3 pool
 * from creation (no bonding curve, confirmed via docs.ponsfamily.com), paired against
 * WETH, so this reads `slot0()` for spot price plus one-time-cached `decimals()` /
 * `totalSupply()` for the tracked token, converts to USD via the caller-supplied
 * ETH/USD price, and never fabricates a figure — any read failure (or missing
 * ethUsdPrice) simply omits that token from the results rather than guessing.
 */
export async function readPoolMarketCaps(
  client: ChainClient,
  tokens: PoolMarketCapInput[],
  ethUsdPrice: number,
  batchSize: number,
  logger: Logger
): Promise<PoolMarketCapResult[]> {
  const results: PoolMarketCapResult[] = [];
  if (tokens.length === 0 || !Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) return results;

  // One-time ERC20 metadata reads for tokens missing a cached decimals/totalSupply.
  const needsMetadata = tokens.filter((t) => t.tokenDecimals == null || t.tokenTotalSupply == null);
  const metadata = new Map<string, { decimals: number; totalSupply: bigint }>();

  for (let i = 0; i < needsMetadata.length; i += batchSize) {
    const batch = needsMetadata.slice(i, i + batchSize);
    const contracts = batch.flatMap((t) => [
      { address: t.tokenAddress as `0x${string}`, abi: [DECIMALS_ABI], functionName: "decimals" as const, args: [] as const },
      { address: t.tokenAddress as `0x${string}`, abi: [TOTAL_SUPPLY_ABI], functionName: "totalSupply" as const, args: [] as const },
    ]);

    let attempt = 0;
    let batchResults: Awaited<ReturnType<ChainClient["multicall"]>> | undefined;
    while (batchResults === undefined) {
      try {
        batchResults = await client.multicall({ contracts, allowFailure: true });
      } catch (err) {
        if (attempt >= MAX_MULTICALL_RETRIES) {
          logger.error(
            { err: String(err), batchSize: batch.length },
            "token metadata multicall batch failed after retries, skipping this batch for now"
          );
          break;
        }
        const backoffMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
        logger.warn({ err: String(err), attempt, backoffMs }, "token metadata multicall batch failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
      }
    }
    if (!batchResults) continue;

    for (let j = 0; j < batch.length; j += 1) {
      const token = batch[j];
      if (!token) continue;
      const decimalsResult = batchResults[j * 2] as { status: string; result?: number | bigint } | undefined;
      const totalSupplyResult = batchResults[j * 2 + 1] as { status: string; result?: bigint } | undefined;
      if (
        decimalsResult?.status === "success" &&
        decimalsResult.result != null &&
        totalSupplyResult?.status === "success" &&
        totalSupplyResult.result != null
      ) {
        metadata.set(token.tokenAddress.toLowerCase(), {
          decimals: Number(decimalsResult.result),
          totalSupply: totalSupplyResult.result,
        });
      }
    }
  }

  // slot0() spot-price reads, batched across each token's pool.
  const slot0ByPool = new Map<string, bigint>();
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const contracts = batch.map((t) => ({
      address: t.poolAddress as `0x${string}`,
      abi: [SLOT0_ABI],
      functionName: "slot0" as const,
      args: [] as const,
    }));

    let attempt = 0;
    let batchResults: Awaited<ReturnType<ChainClient["multicall"]>> | undefined;
    while (batchResults === undefined) {
      try {
        batchResults = await client.multicall({ contracts, allowFailure: true });
      } catch (err) {
        if (attempt >= MAX_MULTICALL_RETRIES) {
          logger.error(
            { err: String(err), batchSize: batch.length },
            "slot0 multicall batch failed after retries, skipping this batch for now"
          );
          break;
        }
        const backoffMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
        logger.warn({ err: String(err), attempt, backoffMs }, "slot0 multicall batch failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
      }
    }
    if (!batchResults) continue;

    for (let j = 0; j < batch.length; j += 1) {
      const token = batch[j];
      if (!token) continue;
      const result = batchResults[j] as { status: string; result?: readonly [bigint, ...unknown[]] } | undefined;
      if (result?.status === "success" && result.result) {
        slot0ByPool.set(token.poolAddress.toLowerCase(), result.result[0]);
      }
    }
  }

  for (const token of tokens) {
    const sqrtPriceX96 = slot0ByPool.get(token.poolAddress.toLowerCase());
    if (sqrtPriceX96 == null) continue;

    const cached = metadata.get(token.tokenAddress.toLowerCase());
    const decimals = token.tokenDecimals ?? cached?.decimals;
    const totalSupplyRaw = token.tokenTotalSupply != null ? BigInt(token.tokenTotalSupply) : cached?.totalSupply;
    if (decimals == null || totalSupplyRaw == null) continue;

    // Uniswap V3 pools deterministically order token0/token1 by ascending address —
    // no extra on-chain call needed to determine which side the tracked token is on.
    const isToken0 = token.tokenAddress.toLowerCase() < token.pairTokenAddress.toLowerCase();
    const decimals0 = isToken0 ? decimals : PAIR_TOKEN_DECIMALS;
    const decimals1 = isToken0 ? PAIR_TOKEN_DECIMALS : decimals;
    const price1Per0 = sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1);
    const priceInPairToken = isToken0 ? price1Per0 : 1 / price1Per0;
    if (!Number.isFinite(priceInPairToken) || priceInPairToken <= 0) continue;

    const priceUsd = priceInPairToken * ethUsdPrice;
    const totalSupplyHuman = Number(totalSupplyRaw) / 10 ** decimals;
    const marketCapUsd = priceUsd * totalSupplyHuman;
    if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) continue;

    results.push({
      tokenAddress: token.tokenAddress,
      priceUsd,
      marketCapUsd,
      decimals,
      totalSupply: totalSupplyRaw.toString(),
    });
  }

  return results;
}

export interface TokenIdentityResult {
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
}

/**
 * Batch-reads `name()`/`symbol()` directly from each token's contract, as a fallback for
 * when DexScreener hasn't (yet) indexed a pair's `baseToken.name`/`symbol` — every Pons
 * token is a live ERC20 from the moment its pool exists, so these calls succeed as soon as
 * the token is discovered, unlike DexScreener's own indexing which can lag. A failed or
 * reverted read (e.g. a non-standard token) simply omits that field rather than guessing.
 */
export async function readTokenIdentities(
  client: ChainClient,
  tokenAddresses: string[],
  batchSize: number,
  logger: Logger
): Promise<TokenIdentityResult[]> {
  const results: TokenIdentityResult[] = [];

  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    const batch = tokenAddresses.slice(i, i + batchSize);
    const contracts = batch.flatMap((address) => [
      { address: address as `0x${string}`, abi: [NAME_ABI], functionName: "name" as const, args: [] as const },
      { address: address as `0x${string}`, abi: [SYMBOL_ABI], functionName: "symbol" as const, args: [] as const },
    ]);

    let attempt = 0;
    let batchResults: Awaited<ReturnType<ChainClient["multicall"]>> | undefined;
    while (batchResults === undefined) {
      try {
        batchResults = await client.multicall({ contracts, allowFailure: true });
      } catch (err) {
        if (attempt >= MAX_MULTICALL_RETRIES) {
          logger.error(
            { err: String(err), batchSize: batch.length },
            "token identity multicall batch failed after retries, skipping this batch for now"
          );
          break;
        }
        const backoffMs = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
        logger.warn({ err: String(err), attempt, backoffMs }, "token identity multicall batch failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
      }
    }
    if (!batchResults) continue;

    for (let j = 0; j < batch.length; j += 1) {
      const address = batch[j];
      if (!address) continue;
      const nameResult = batchResults[j * 2] as { status: string; result?: string } | undefined;
      const symbolResult = batchResults[j * 2 + 1] as { status: string; result?: string } | undefined;
      results.push({
        tokenAddress: address,
        name: nameResult?.status === "success" && nameResult.result ? nameResult.result : null,
        symbol: symbolResult?.status === "success" && symbolResult.result ? symbolResult.result : null,
      });
    }
  }

  return results;
}

/**
 * Reads a single ERC20 `balanceOf(holderAddress)` for `tokenAddress`, used to check
 * whether a token's deployer still holds its own supply before sending an alert. A
 * single on-chain read (not batched, called only when an alert is about to fire, not
 * every poll cycle). Returns `null` on any failure (reverted call, RPC error, etc.)
 * rather than guessing — callers must omit the dev-status field entirely when this
 * returns `null`.
 */
export async function readTokenBalance(
  client: ChainClient,
  tokenAddress: string,
  holderAddress: string
): Promise<bigint | null> {
  try {
    const balance = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: [BALANCE_OF_ABI],
      functionName: "balanceOf",
      args: [holderAddress as `0x${string}`],
    });
    return balance;
  } catch {
    return null;
  }
}

/**
 * Reads a single ERC20 `totalSupply()` for `tokenAddress`. A single on-chain read,
 * called only when an alert is about to fire. Returns `null` on any failure rather
 * than guessing — callers must omit any dependent field entirely when this returns
 * `null`.
 */
export async function readTotalSupply(client: ChainClient, tokenAddress: string): Promise<bigint | null> {
  try {
    const supply = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: [TOTAL_SUPPLY_ABI],
      functionName: "totalSupply",
    });
    return supply;
  } catch {
    return null;
  }
}

export interface EarlyBuyConcentrationResult {
  /** Share of total supply (0-100) bought by the single largest early buyer. */
  topBuyerPct: number;
  /** Combined share of total supply (0-100) bought by the top 5 early buyers. */
  top5Pct: number;
}

/**
 * Measures real early-buyer concentration ("bundle %" in Bubblemaps' terminology): the
 * share of total supply bought by the largest wallets in the first `windowBlocks` blocks
 * after a token's launch. A single bounded `getLogs` call for the token's own ERC20
 * `Transfer` events, restricted to `fromBlock: launchBlock, toBlock: launchBlock +
 * windowBlocks`, then summed **only for transfers originating from the token's own pool**
 * (`from === poolAddress`) — i.e. real DEX buys, excluding wallet-to-wallet transfers and
 * the initial LP-seed mint. Returns `null` when the log query fails, when there are no
 * matching buys, or when `totalSupply` is not positive — never fabricated.
 */
export async function readEarlyBuyConcentration(
  client: ChainClient,
  tokenAddress: string,
  launchBlock: bigint,
  windowBlocks: number,
  poolAddress: string,
  totalSupply: bigint,
  logger: Logger
): Promise<EarlyBuyConcentrationResult | null> {
  if (totalSupply <= 0n) return null;
  const pool = poolAddress.toLowerCase();

  try {
    const logs = await client.getLogs({
      address: tokenAddress as `0x${string}`,
      event: TRANSFER_EVENT,
      fromBlock: launchBlock,
      toBlock: launchBlock + BigInt(windowBlocks),
    });

    const boughtByRecipient = new Map<string, bigint>();
    for (const log of logs) {
      const args = (log as unknown as { args: { from?: string; to?: string; value?: bigint } }).args;
      if (!args?.from || !args.to || args.value === undefined) continue;
      if (args.from.toLowerCase() !== pool) continue;
      const recipient = args.to.toLowerCase();
      if (recipient === ZERO_ADDRESS) continue;
      boughtByRecipient.set(recipient, (boughtByRecipient.get(recipient) ?? 0n) + args.value);
    }

    if (boughtByRecipient.size === 0) return null;

    const sorted = [...boughtByRecipient.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    const top1 = sorted[0] ?? 0n;
    const top5Value = sorted.slice(0, 5).reduce((sum, v) => sum + v, 0n);

    return {
      topBuyerPct: (Number(top1) / Number(totalSupply)) * 100,
      top5Pct: (Number(top5Value) / Number(totalSupply)) * 100,
    };
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "Early-buy-concentration getLogs failed");
    return null;
  }
}
