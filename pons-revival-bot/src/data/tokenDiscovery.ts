import type { Logger } from "pino";
import type { ChainClient } from "./chainClient.js";
import { scanTokenLaunches, readTokenIdentities } from "./chainClient.js";
import type { DiscoveryStateRepo } from "./discoveryStateRepo.js";
import type { TokenRepo } from "./tokenRepo.js";
import type { DexScreenerClient } from "./dexscreener.js";
import { indexPairsByToken, pickCanonicalPair } from "./dexscreener.js";

export interface FactoryConfig {
  address: string;
  startBlock: bigint;
}

export interface DiscoveryDeps {
  chainClient: ChainClient;
  discoveryStateRepo: DiscoveryStateRepo;
  tokenRepo: TokenRepo;
  dex: DexScreenerClient;
  dexScreenerChainId: string;
  chunkBlocks: number;
  /** Max launches one discovery pass may accumulate before deferring the rest to the next
   * cycle. Bounds peak memory during a catch-up after downtime. */
  maxLaunchesPerCycle: number;
  /** How far back a cold start reaches when a factory has no cursor. */
  coldStartLookbackBlocks: number;
  minLiquidityUsd: number;
  spamDeployerThreshold: number;
  /** Batch size for the on-chain name()/symbol() fallback multicall (reuses the same
   * general-purpose batch size as graduation/market-cap multicalls). */
  identityBatchSize: number;
  logger: Logger;
}

/**
 * Scans all configured Pons factories for new TokenLaunched events since each
 * factory's last persisted cursor, then looks up market data for any newly
 * discovered tokens on DexScreener to capture their pair address and initial
 * identity.
 *
 * Every discovered token is inserted before the discovery cursor is advanced past it
 * (the cursor write is deferred until the DexScreener lookup and every insert below
 * have completed without throwing) — a token that isn't durably inserted now could
 * never be discovered again later, since the cursor would otherwise already be past
 * its block. Tokens are inserted as 'active' only if DexScreener already has data for
 * them with liquidity at or above `minLiquidityUsd`. Otherwise (not yet indexed, or
 * below the liquidity floor, or from a known spam deployer) they're inserted as
 * 'unindexed', which the main poll loop excludes from its per-cycle DexScreener
 * lookup — they're only rechecked by a separate, much less frequent sweep.
 */
export async function runDiscovery(deps: DiscoveryDeps, factories: FactoryConfig[]): Promise<number> {
  const {
    chainClient,
    discoveryStateRepo,
    tokenRepo,
    dex,
    dexScreenerChainId,
    chunkBlocks,
    maxLaunchesPerCycle,
    coldStartLookbackBlocks,
    minLiquidityUsd,
    spamDeployerThreshold,
    identityBatchSize,
    logger,
  } = deps;

  // Map (not Set) so we retain each token's deployer + originating factory address, plus
  // its pool/pairToken addresses (captured from the TokenLaunched event itself, needed for
  // on-chain market cap resolution of tokens DexScreener hasn't indexed yet).
  const newlyDiscovered = new Map<
    string,
    {
      deployer: string | null;
      factory: string;
      poolAddress: string | null;
      pairTokenAddress: string | null;
      launchBlock: bigint;
    }
  >();
  // Cursor advances are deferred until every newly-discovered token from this run has
  // been safely looked up and inserted (see comment below the insertion loop for why).
  const pendingCursors = new Map<string, bigint>();

  const head = await chainClient.getBlockNumber();
  for (const factory of factories) {
    // With no cursor, start near the head rather than at the factory's deploy block.
    //
    // Those are ~44 million blocks apart, so a cold start (or a deliberate reset of the
    // coin registry) would spend days replaying ancient launches before reaching today —
    // during which nothing currently launching is seen at all. Recent history is what
    // matters for a bot alerting on live moves; anything older is the backfill's problem.
    const stored = discoveryStateRepo.getLastScannedBlock(factory.address);
    const coldStart = head > BigInt(coldStartLookbackBlocks) ? head - BigInt(coldStartLookbackBlocks) : 0n;
    const cursor = stored ?? (coldStart > factory.startBlock ? coldStart : factory.startBlock);
    const { launches, reachedBlock } = await scanTokenLaunches(
      chainClient,
      factory.address,
      cursor,
      chunkBlocks,
      logger,
      maxLaunchesPerCycle
    );

    for (const launch of launches) {
      newlyDiscovered.set(launch.tokenAddress.toLowerCase(), {
        deployer: launch.deployerAddress,
        factory: factory.address,
        poolAddress: launch.poolAddress,
        pairTokenAddress: launch.pairTokenAddress,
        launchBlock: launch.blockNumber,
      });
    }

    pendingCursors.set(factory.address, reachedBlock + 1n);
    logger.info(
      { factory: factory.address, launches: launches.length, reachedBlock: reachedBlock.toString() },
      "Discovery scan chunk complete"
    );
  }

  if (newlyDiscovered.size === 0) {
    for (const [factoryAddress, nextCursor] of pendingCursors) {
      discoveryStateRepo.setLastScannedBlock(factoryAddress, nextCursor);
    }
    return 0;
  }

  const addresses = [...newlyDiscovered.keys()];

  // Skip the spam-deployer addresses' tokens entirely — no need to burn a DexScreener
  // lookup on tokens we're going to mark 'unindexed' regardless of what it returns.
  const spamDeployerCache = new Map<string, boolean>();
  const isSpamDeployer = (deployer: string | null): boolean => {
    if (!deployer) return false;
    const key = deployer.toLowerCase();
    let isSpam = spamDeployerCache.get(key);
    if (isSpam === undefined) {
      isSpam = tokenRepo.countByDeployer(key) >= spamDeployerThreshold;
      spamDeployerCache.set(key, isSpam);
    }
    return isSpam;
  };

  const lookupAddresses = addresses.filter((address) => !isSpamDeployer(newlyDiscovered.get(address)?.deployer ?? null));
  const pairs = lookupAddresses.length > 0 ? await dex.lookupBatch(dexScreenerChainId, lookupAddresses) : [];
  const pairsByToken = indexPairsByToken(pairs);

  // DexScreener can legitimately have no baseToken.name/symbol yet for brand-new pairs
  // (its metadata indexing lags behind pair discovery). Rather than fall straight to the
  // "?"/"Unknown" placeholder — which then renders literally in every alert — read the
  // real identity directly from each such token's own ERC20 contract, which is live from
  // the moment its pool exists.
  const needsIdentityFallback = lookupAddresses.filter((address) => {
    const pair = pickCanonicalPair(pairsByToken, address);
    return !pair?.baseToken.symbol || !pair?.baseToken.name;
  });
  let onChainIdentityByAddress = new Map<string, { name: string | null; symbol: string | null }>();
  if (needsIdentityFallback.length > 0) {
    const identities = await readTokenIdentities(chainClient, needsIdentityFallback, identityBatchSize, logger);
    onChainIdentityByAddress = new Map(identities.map((i) => [i.tokenAddress.toLowerCase(), i]));
  }

  const now = Date.now();
  let inserted = 0;

  for (const address of addresses) {
    const info = newlyDiscovered.get(address);
    const deployer = info?.deployer ?? null;
    const factoryAddress = info?.factory ?? null;
    const poolAddress = info?.poolAddress ?? null;
    const pairTokenAddress = info?.pairTokenAddress ?? null;
    const launchBlock = info?.launchBlock?.toString() ?? null;

    if (isSpamDeployer(deployer)) {
      tokenRepo.insertIfNew(
        address,
        "?",
        "Unknown",
        "",
        "unindexed",
        deployer,
        factoryAddress,
        now,
        poolAddress,
        pairTokenAddress,
        launchBlock
      );
      inserted += 1;
      continue;
    }

    const pair = pickCanonicalPair(pairsByToken, address);
    const liquidityUsd = pair?.liquidity?.usd ?? 0;
    const onChainIdentity = onChainIdentityByAddress.get(address);
    const symbol = pair?.baseToken.symbol ?? onChainIdentity?.symbol ?? "?";
    const name = pair?.baseToken.name ?? onChainIdentity?.name ?? onChainIdentity?.symbol ?? symbol ?? "Unknown";

    if (pair && liquidityUsd >= minLiquidityUsd) {
      tokenRepo.insertIfNew(
        address,
        symbol,
        name,
        pair.pairAddress,
        "active",
        deployer,
        factoryAddress,
        now,
        poolAddress,
        pairTokenAddress,
        launchBlock
      );
    } else {
      logger.info(
        { address, indexed: Boolean(pair), liquidityUsd },
        "Newly discovered token below liquidity floor or not yet indexed, tracking as unindexed"
      );
      tokenRepo.insertIfNew(
        address,
        symbol,
        name,
        pair?.pairAddress ?? "",
        "unindexed",
        deployer,
        factoryAddress,
        now,
        poolAddress,
        pairTokenAddress,
        launchBlock
      );
    }
    inserted += 1;
  }

  if (inserted !== addresses.length) {
    logger.warn(
      { discovered: addresses.length, inserted },
      "Discovered token count doesn't match inserted count"
    );
  }

  // Only advance the persisted cursors once every newly-discovered token from this run
  // has been safely inserted. If the DexScreener lookup or any insert above threw, we
  // never reach this line — the cursor stays put and the next cycle retries the exact
  // same block range (safe: `insertIfNew` is idempotent) instead of silently losing
  // whatever was discovered in this pass.
  for (const [factoryAddress, nextCursor] of pendingCursors) {
    discoveryStateRepo.setLastScannedBlock(factoryAddress, nextCursor);
  }

  return inserted;
}
