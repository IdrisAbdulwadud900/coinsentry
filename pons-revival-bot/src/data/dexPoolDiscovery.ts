import type { Logger } from "pino";
import type { DiscoveryStateRepo } from "./discoveryStateRepo.js";
import type { TokenRepo } from "./tokenRepo.js";
import type { DexScreenerClient } from "./dexscreener.js";
import { indexPairsByToken, pickCanonicalPair } from "./dexscreener.js";
import { DEFAULT_CHAIN, normalizeAddress } from "./chains.js";

/**
 * A DEX pool-creation event to watch. Every AMM announces new pools with an event whose
 * indexed topics carry the two token addresses, so one generic scanner covers V2, V3 and
 * V4 by just varying the topic layout.
 */
export interface PoolSource {
  label: string;
  address: string;
  /** keccak256 of the event signature. */
  topic0: string;
  /** Which indexed topic holds each token address (topics[0] is always the signature). */
  token0TopicIndex: number;
  token1TopicIndex: number;
}

/** One chain's scanning setup: where to read, how far, and what counts as a quote asset. */
export interface ChainPoolConfig {
  /** DexScreener chainId slug — also what gets stored in `tokens.chain`. */
  chain: string;
  rpcUrl: string;
  /** Blocks per getLogs call. Sized per chain: free Ethereum RPCs reject wide ranges as
   * "archive" requests, while Robinhood's 101ms blocks need wide ones to keep up. */
  chunkBlocks: number;
  /** How far back to look when a source has no cursor yet — roughly one hour on each
   * chain. Also the ceiling on how far behind a cursor may fall (see the catch-up guard
   * in the scan loop), which is what keeps free Ethereum RPCs from refusing every call
   * after any extended downtime. */
  backfillBlocks: number;
  /** Never the "interesting" side of a new pool. */
  quoteAssets: string[];
  /** How deep into the past the backward sweep will eventually reach, in blocks. Sized per
   * chain to cover roughly the last week, since a coin that launched before this bot
   * started watching can still be the one that runs. */
  historyBlocks: number;
  /** Chunks of backward history to sweep per cycle, per source. Bounded so the backfill
   * shares the cycle with live scanning instead of monopolising it. */
  backfillChunksPerCycle: number;
  /** Hard ceiling on tokens the backward sweep may add per cycle, so a busy chain's history
   * can never flood the volume the way an uncapped import already did once. */
  maxHistoricalInsertsPerCycle: number;
  /**
   * Chunks the *forward* scan may cover in one cycle. The loop used to run to the chain
   * head unconditionally, which is invisible while the bot keeps up and ruinous once it
   * falls behind: after days offline it walked millions of blocks in a single pass, holding
   * every discovered address and its market lookups at once, and died on the heap limit —
   * which kept it behind, so the next pass was bigger still. A fixed budget loses nothing,
   * because the cursor persists exactly where the scan stopped.
   */
  maxForwardChunksPerCycle: number;
  sources: PoolSource[];
}

const V3_POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const V4_INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

/**
 * Robinhood Chain pool factories, all verified live on-chain.
 *
 * The Pons launchpad factories this bot was originally built around only produce a
 * fraction of the chain's tokens — a coin can be launched straight onto any of these DEXes
 * and never touch Pons, in which case the launchpad scan never sees it. That is exactly how
 * a token like DORK (a Uniswap V4 pool, $290k market cap) stayed completely untracked.
 * Watching the DEXes themselves closes that hole for good.
 */
export const ROBINHOOD_POOL_SOURCES: PoolSource[] = [
  {
    // Uniswap V4 PoolManager — Initialize(bytes32 indexed id, address indexed currency0,
    // address indexed currency1, ...). Token addresses are in topics 2 and 3 because
    // topic 1 is the pool id.
    label: "uniswap-v4-poolmanager",
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    topic0: V4_INITIALIZE,
    token0TopicIndex: 2,
    token1TopicIndex: 3,
  },
  {
    // Uniswap V3 factory — PoolCreated(address indexed token0, address indexed token1,
    // uint24 indexed fee, int24 tickSpacing, address pool). ~60% of new pools.
    label: "uniswap-v3-factory",
    address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    topic0: V3_POOL_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
  // V2-style factories — PairCreated(address indexed token0, address indexed token1,
  // address pair, uint). All three verified emitting live on 2026-08-03.
  { label: "v2-factory-a", address: "0x0d1ebb179cdbca88d74c923c4255cb2b17474afd", topic0: V2_PAIR_CREATED, token0TopicIndex: 1, token1TopicIndex: 2 },
  { label: "v2-factory-b", address: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f", topic0: V2_PAIR_CREATED, token0TopicIndex: 1, token1TopicIndex: 2 },
  { label: "v2-factory-c", address: "0xfc2e4da3edb2e18100473339c763705d263d20a9", topic0: V2_PAIR_CREATED, token0TopicIndex: 1, token1TopicIndex: 2 },
];

/** PancakeSwap V2 — verified emitting on 2026-08-04 (~10 pools per 2,000 blocks). The V3
 * factory produced nothing over 20,000 blocks, so it is deliberately left out rather than
 * shipped on an unverified address. */
export const BSC_POOL_SOURCES: PoolSource[] = [
  {
    label: "pancake-v2-factory",
    address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    topic0: V2_PAIR_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
];

/** Uniswap V2 and V3 on Ethereum — both verified emitting on 2026-08-04. */
export const ETHEREUM_POOL_SOURCES: PoolSource[] = [
  {
    label: "uniswap-v2-factory",
    address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    topic0: V2_PAIR_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
  {
    label: "uniswap-v3-factory",
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    topic0: V3_POOL_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
];

/**
 * HyperEVM launch venues, established by sweeping ~36,000 blocks of live chain history for
 * both pool-creation topics and counting what each factory actually emitted.
 *
 * The V3 factory below is a real, live contract (24kB of code) but produced **zero** pools
 * over that entire window, while this V2 factory produced every new pair seen — BingBong,
 * AVELO and FAM, all quoted in WHYPE. Watching V3 alone, as this config originally did,
 * meant HyperEVM could never discover a single token. V3 is kept because it costs one
 * getLogs call and would catch a venue shift, but V2 is where launches happen today.
 */
export const HYPEREVM_POOL_SOURCES: PoolSource[] = [
  {
    label: "hyperswap-v2-factory",
    address: "0x724412c00059bf7d6ee7d4a1d0d5cd4de3ea1c48",
    topic0: V2_PAIR_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
  {
    label: "hyperswap-v3-factory",
    address: "0xb1c0fa0b789320044a6f623cfe5ebda9562602e3",
    topic0: V3_POOL_CREATED,
    token0TopicIndex: 1,
    token1TopicIndex: 2,
  },
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ROBINHOOD_QUOTE_ASSETS = [
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH — quotes ~98% of pools
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  ZERO_ADDRESS, // native, as used by Uniswap V4
];

export const BSC_QUOTE_ASSETS = [
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  ZERO_ADDRESS,
];

export const ETHEREUM_QUOTE_ASSETS = [
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  ZERO_ADDRESS,
];

export const HYPEREVM_QUOTE_ASSETS = [
  "0x5555555555555555555555555555555555555555", // WHYPE — the chain's wrapped native asset
  ZERO_ADDRESS,
];

export interface DexPoolDiscoveryDeps {
  discoveryStateRepo: DiscoveryStateRepo;
  tokenRepo: TokenRepo;
  dex: DexScreenerClient;
  minLiquidityUsd: number;
  logger: Logger;
}

/** An indexed address topic is a 32-byte word; the address is its low 20 bytes. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/** Minimal JSON-RPC call. Deliberately not viem: this only ever needs raw topic filtering,
 * and going direct means each chain is just a URL rather than a configured client. */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} responded ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/**
 * Discovers tokens by watching DEX pool-creation events directly, rather than a single
 * launchpad's factory. This is what catches coins launched outside Pons — which is most of
 * the chain — and is now the discovery path for BSC and Ethereum too, where the bot
 * previously relied on DexScreener's promoted feeds and consequently tracked almost
 * nothing (39 BSC and 12 Ethereum tokens, versus 125k on Robinhood).
 *
 * Tokens found here get no `factory_address`, so the Pons-specific graduation and
 * bonding-curve tracking correctly skips them; everything else (market data,
 * classification, gates, alerts, the observer) works identically.
 */
export async function runDexPoolDiscovery(deps: DexPoolDiscoveryDeps, chains: ChainPoolConfig[]): Promise<number> {
  const { discoveryStateRepo, tokenRepo, dex, minLiquidityUsd, logger } = deps;
  let insertedTotal = 0;

  for (const chainConfig of chains) {
    const { chain, rpcUrl, chunkBlocks, backfillBlocks, sources } = chainConfig;
    const quoteAssets = new Set(chainConfig.quoteAssets.map((a) => a.toLowerCase()));

    let head: bigint;
    try {
      head = BigInt((await rpcCall(rpcUrl, "eth_blockNumber", [])) as string);
    } catch (err) {
      logger.warn({ chain, err: String(err) }, "Pool discovery could not read chain head, skipping this cycle");
      continue;
    }

    const discovered = new Set<string>();
    // Tokens found by the backward sweep are held separately: unlike a brand-new pool,
    // a coin from history is only worth tracking if it is still alive *now*, so these are
    // filtered on current liquidity before being stored. See the insertion loop below.
    const historical = new Set<string>();
    const pendingCursors = new Map<string, bigint>();

    for (const source of sources) {
      // Cursors are namespaced by chain: the same factory label (or even address) can
      // legitimately exist on more than one chain.
      const cursorKey = `${chain}:${source.label}`;
      const stored = discoveryStateRepo.getLastScannedBlock(cursorKey);
      const earliest = head > BigInt(backfillBlocks) ? head - BigInt(backfillBlocks) : 0n;
      // Catch-up guard: after any extended downtime a stored cursor can fall far enough
      // behind that free RPCs refuse the range as an archive request, which would wedge
      // this source permanently. Skipping forward loses the gap but keeps discovery alive.
      let cursor = stored != null && stored > earliest ? stored : earliest;
      // Where the forward scan begins this cycle, and therefore the point the backward
      // sweep below works down from on its first run.
      const cursorStart = cursor;
      if (stored != null && stored < earliest) {
        logger.warn(
          { chain, source: source.label, storedCursor: stored.toString(), resumingAt: earliest.toString() },
          "Pool discovery cursor too far behind for this RPC's window, skipping ahead"
        );
      }
      let reached = cursor;

      let forwardChunks = 0;
      while (cursor <= head && forwardChunks < chainConfig.maxForwardChunksPerCycle) {
        forwardChunks += 1;
        const toBlock = cursor + BigInt(chunkBlocks) - 1n > head ? head : cursor + BigInt(chunkBlocks) - 1n;
        try {
          const logs = (await rpcCall(rpcUrl, "eth_getLogs", [
            {
              address: source.address,
              fromBlock: `0x${cursor.toString(16)}`,
              toBlock: `0x${toBlock.toString(16)}`,
              topics: [source.topic0],
            },
          ])) as { topics: string[] }[];

          for (const log of logs) {
            for (const index of [source.token0TopicIndex, source.token1TopicIndex]) {
              const topic = log.topics[index];
              if (!topic) continue;
              const address = addressFromTopic(topic);
              if (quoteAssets.has(address)) continue;
              discovered.add(address);
            }
          }
          reached = toBlock;
        } catch (err) {
          // Stop this source here; the cursor stays at the last good block so the next
          // cycle retries the failed range rather than skipping past it.
          logger.warn(
            { chain, source: source.label, fromBlock: cursor.toString(), toBlock: toBlock.toString(), err: String(err) },
            "Pool discovery chunk failed, will retry next cycle"
          );
          break;
        }
        cursor = toBlock + 1n;
      }
      pendingCursors.set(cursorKey, reached + 1n);

      // Backward sweep. The forward cursor above starts at whatever the head was the first
      // time this source ran, so every pool created before that moment is invisible
      // forever — and a coin does not have to be new to run. A real miss: ABE
      // (0x759d161b…), a Uniswap V4 pool created 2026-07-30, days before this discovery
      // path existed. It went from $3k to $26k and the bot could not alert on it because
      // the token was never in the database at all. This pass walks history backwards a
      // bounded number of chunks per cycle until it has covered `historyBlocks`, so
      // already-launched coins get imported once and then behave like any other token.
      const backfillKey = `${cursorKey}:backfill`;
      const historyFloor = head > BigInt(chainConfig.historyBlocks) ? head - BigInt(chainConfig.historyBlocks) : 0n;
      let backfillCursor = discoveryStateRepo.getLastScannedBlock(backfillKey) ?? cursorStart;

      for (let chunk = 0; chunk < chainConfig.backfillChunksPerCycle && backfillCursor > historyFloor; chunk += 1) {
        const toBlock = backfillCursor - 1n;
        const fromBlock = toBlock >= BigInt(chunkBlocks) ? toBlock - BigInt(chunkBlocks) + 1n : 0n;
        const clamped = fromBlock < historyFloor ? historyFloor : fromBlock;
        try {
          const logs = (await rpcCall(rpcUrl, "eth_getLogs", [
            {
              address: source.address,
              fromBlock: `0x${clamped.toString(16)}`,
              toBlock: `0x${toBlock.toString(16)}`,
              topics: [source.topic0],
            },
          ])) as { topics: string[] }[];

          for (const log of logs) {
            for (const index of [source.token0TopicIndex, source.token1TopicIndex]) {
              const topic = log.topics[index];
              if (!topic) continue;
              const address = addressFromTopic(topic);
              if (quoteAssets.has(address)) continue;
              if (!discovered.has(address)) historical.add(address);
            }
          }
          backfillCursor = clamped;
        } catch (err) {
          // Same contract as the forward scan: leave the cursor where it is so the failed
          // range is retried rather than silently skipped.
          logger.warn(
            { chain, source: source.label, fromBlock: clamped.toString(), toBlock: toBlock.toString(), err: String(err) },
            "Pool discovery backfill chunk failed, will retry next cycle"
          );
          break;
        }
      }
      // Only persist a cursor the sweep actually moved, so a chain with the backward sweep
      // switched off leaves no state behind at all.
      if (backfillCursor < cursorStart) pendingCursors.set(backfillKey, backfillCursor);
    }

    // Only tokens we've never seen need resolving — most of each scan is already-tracked
    // tokens reappearing via another pool.
    //
    // The backward sweep is capped separately. Robinhood alone mints ~18.7k tokens a day,
    // so an uncapped historical import is not a discovery feature but a disk-filling one:
    // it added ~90k rows in a single cycle, took the database to 908MB on a 1GB volume and
    // crash-looped the bot on "database or disk is full". The cap bounds each cycle's
    // damage, and `historyRequiresLiquidity` below discards the dead majority outright.
    const forwardUnseen = [...discovered].filter((address) => tokenRepo.findByAddress(address) === undefined);
    const historicalUnseen = [...historical]
      .filter((address) => tokenRepo.findByAddress(address) === undefined)
      .slice(0, chainConfig.maxHistoricalInsertsPerCycle);
    const historicalSet = new Set(historicalUnseen);
    const unseen = [...forwardUnseen, ...historicalUnseen];
    let inserted = 0;

    if (unseen.length > 0) {
      const now = Date.now();
      for (let i = 0; i < unseen.length; i += 30) {
        const batch = unseen.slice(i, i + 30);
        let pairs;
        try {
          pairs = await dex.lookupBatch(chain, batch);
        } catch (err) {
          logger.warn({ chain, err: String(err) }, "Pool discovery market lookup failed, tokens retried next cycle");
          continue;
        }
        const pairsByToken = indexPairsByToken(pairs);

        for (const address of batch) {
          if (tokenRepo.findByAddress(address) !== undefined) continue;
          const pair = pickCanonicalPair(pairsByToken, address);
          const liquidityUsd = pair?.liquidity?.usd ?? 0;
          // A coin discovered from history has already had its chance to matter. If it has
          // no live pair with real liquidity today, it is one of the thousands of dead
          // launches this chain produces daily and storing it buys nothing. A new pool from
          // the forward scan is still stored either way, because it has not had that chance
          // yet and may be minutes old.
          if (historicalSet.has(address) && liquidityUsd < minLiquidityUsd) continue;
          const symbol = pair?.baseToken.symbol ?? "?";
          const name = pair?.baseToken.name ?? symbol;
          const firstSeenAt = pair?.pairCreatedAt && pair.pairCreatedAt > 0 ? pair.pairCreatedAt : now;

          tokenRepo.insertIfNew(
            normalizeAddress(address),
            symbol,
            name,
            pair?.pairAddress ?? "",
            pair && liquidityUsd >= minLiquidityUsd ? "active" : "unindexed",
            null,
            null, // no Pons factory — graduation/bonding-curve tracking correctly skips these
            firstSeenAt,
            null,
            null,
            null,
            chain
          );
          if (pair?.info?.imageUrl) tokenRepo.setImageUrlIfMissing(normalizeAddress(address), pair.info.imageUrl);
          inserted += 1;
        }
      }
    }

    // Cursors advance only after every token from this pass is safely inserted, mirroring
    // the Pons discovery path: a token that isn't durably stored now could never be found
    // again once the cursor moved past its block.
    for (const [key, next] of pendingCursors) {
      discoveryStateRepo.setLastScannedBlock(key, next);
    }

    if (inserted > 0) {
      logger.info({ chain, inserted, scanned: discovered.size }, "Pool discovery inserted new tokens");
    }
    insertedTotal += inserted;
  }

  return insertedTotal;
}

/** Builds the per-chain scanning setup from configured RPC URLs. A chain with no RPC
 * configured is simply not scanned. Block budgets are sized to each chain's block time so
 * every source covers roughly the same wall-clock window. */
export function buildPoolChainConfigs(rpcUrls: {
  robinhood: string;
  bsc?: string;
  ethereum?: string;
  hyperevm?: string;
}): ChainPoolConfig[] {
  const configs: ChainPoolConfig[] = [
    {
      chain: DEFAULT_CHAIN,
      rpcUrl: rpcUrls.robinhood,
      // ~101ms blocks: 20k blocks ≈ 34 min, 36k ≈ 1 hour.
      chunkBlocks: 20_000,
      backfillBlocks: 36_000,
      // ~856k blocks/day. 9M blocks is ~10.5 days, chosen because a 7-day window would
      // have stopped just short of ABE (0x759d161b…), a pool created 7.9 days before it
      // was noticed running $3k -> $26k. Since the sweep now stores only historical tokens
      // that still have live liquidity, reaching further back costs lookups, not disk.
      historyBlocks: 9_000_000,
      // Deliberately small. At 15 chunks this sweep plus the DexScreener lookups for the
      // hundreds of tokens it turned up consumed the entire poll cycle: the cycle stopped
      // finishing, the fast poller logged "previous cycle still running" every tick, and
      // no market snapshot was written for over an hour — which means no alerts at all.
      // Backfilling history is a background nicety; the live market scan is the product.
      backfillChunksPerCycle: 3,
      maxHistoricalInsertsPerCycle: 100,
      // 5 x 20k = 100k blocks/cycle, well ahead of the ~8.9k this chain produces
      // between cycles, so it still catches up — just never in one unbounded pass.
      maxForwardChunksPerCycle: 5,
      quoteAssets: ROBINHOOD_QUOTE_ASSETS,
      sources: ROBINHOOD_POOL_SOURCES,
    },
  ];
  if (rpcUrls.bsc) {
    configs.push({
      chain: "bsc",
      rpcUrl: rpcUrls.bsc,
      // ~3s blocks: 1,200 blocks ≈ 1 hour.
      chunkBlocks: 1_000,
      backfillBlocks: 1_200,
      // ~28.8k blocks/day → a week is ~200k blocks.
      historyBlocks: 200_000,
      backfillChunksPerCycle: 6,
      maxHistoricalInsertsPerCycle: 200,
      // 5 x 1k covers ~4 hours of BSC blocks per cycle.
      maxForwardChunksPerCycle: 5,
      quoteAssets: BSC_QUOTE_ASSETS,
      sources: BSC_POOL_SOURCES,
    });
  }
  if (rpcUrls.ethereum) {
    configs.push({
      chain: "ethereum",
      rpcUrl: rpcUrls.ethereum,
      // ~12s blocks: 300 blocks ≈ 1 hour. Kept deliberately narrow — free Ethereum RPCs
      // reject wider windows as archive requests.
      chunkBlocks: 300,
      backfillBlocks: 300,
      // ~7.2k blocks/day → a week is ~50k. Kept to 2 chunks/cycle because free Ethereum
      // RPCs are the quickest to start refusing historical ranges.
      historyBlocks: 50_000,
      backfillChunksPerCycle: 2,
      maxHistoricalInsertsPerCycle: 100,
      // Kept low; free Ethereum RPCs refuse wide historical ranges.
      maxForwardChunksPerCycle: 4,
      quoteAssets: ETHEREUM_QUOTE_ASSETS,
      sources: ETHEREUM_POOL_SOURCES,
    });
  }
  if (rpcUrls.hyperevm) {
    configs.push({
      chain: "hyperevm",
      rpcUrl: rpcUrls.hyperevm,
      // This chain's RPCs cap getLogs at 1,000 blocks, so the chunk must stay under it.
      chunkBlocks: 900,
      backfillBlocks: 1_800,
      // ~1s blocks → a week is ~600k blocks; launches here are rare enough that the sweep
      // mostly returns empty, so it can afford a wider slice per cycle.
      historyBlocks: 600_000,
      backfillChunksPerCycle: 10,
      maxHistoricalInsertsPerCycle: 100,
      // Launches are rare here, so most chunks come back empty and cost little.
      maxForwardChunksPerCycle: 8,
      quoteAssets: HYPEREVM_QUOTE_ASSETS,
      sources: HYPEREVM_POOL_SOURCES,
    });
  }
  return configs;
}
