import type { Logger } from "pino";
import type { TokenRepo } from "./tokenRepo.js";
import type { DexScreenerClient } from "./dexscreener.js";
import { indexPairsByToken, pickCanonicalPair } from "./dexscreener.js";
import { DEFAULT_CHAIN, normalizeAddress } from "./chains.js";

export interface MultiChainDiscoveryDeps {
  tokenRepo: TokenRepo;
  dex: DexScreenerClient;
  /** Chains to accept from the feeds. Anything else is ignored. */
  enabledChains: string[];
  /** Same liquidity floor the Robinhood discovery path uses to decide active vs unindexed. */
  minLiquidityUsd: number;
  logger: Logger;
}

/**
 * Discovery for every chain where this bot has no contract-level launch scanning
 * (Solana, BSC, Ethereum — everything except Robinhood/Pons). Pulls DexScreener's
 * cross-chain profile/boost feeds, then resolves real market data for anything new so
 * each token is tracked with a genuine pair address, identity, and liquidity-based
 * status — never a placeholder.
 *
 * `first_seen_at` is set from the pair's real `pairCreatedAt` when DexScreener reports
 * it, so the age-bounded momentum window measures the token's actual age rather than
 * "when this bot happened to notice it".
 *
 * Address collisions: tokens are keyed by address alone (a pre-existing schema
 * constraint). A token whose address is already tracked on a *different* chain is
 * skipped and logged rather than silently overwriting the existing row — realistically
 * only reachable for deterministic multi-chain deploys, never for random memecoins.
 */
export async function runMultiChainDiscovery(deps: MultiChainDiscoveryDeps): Promise<number> {
  const { tokenRepo, dex, enabledChains, minLiquidityUsd, logger } = deps;

  const enabled = new Set(enabledChains.filter((c) => c !== DEFAULT_CHAIN));
  if (enabled.size === 0) return 0;

  const feed = await dex.fetchDiscoveryFeeds();
  const candidates = feed.filter((t) => enabled.has(t.chainId));
  if (candidates.length === 0) return 0;

  // Only look up addresses we don't already track — the feeds repeat the same tokens
  // across polls, and re-resolving them every cycle would waste the request budget.
  const unseen = candidates.filter((t) => tokenRepo.findByAddress(t.tokenAddress) === undefined);
  if (unseen.length === 0) return 0;

  const byChain = new Map<string, string[]>();
  for (const t of unseen) {
    const list = byChain.get(t.chainId);
    if (list) list.push(t.tokenAddress);
    else byChain.set(t.chainId, [t.tokenAddress]);
  }

  const now = Date.now();
  let inserted = 0;

  for (const [chainId, addresses] of byChain) {
    let pairs;
    try {
      pairs = await dex.lookupBatch(chainId, addresses);
    } catch (err) {
      logger.warn({ chainId, err: String(err) }, "Multi-chain discovery lookup failed, will retry next cycle");
      continue;
    }
    const pairsByToken = indexPairsByToken(pairs);

    for (const address of addresses) {
      // Re-check inside the loop: an earlier chain in this same pass may have inserted it.
      const existing = tokenRepo.findByAddress(address);
      if (existing) {
        if (existing.chain !== chainId) {
          logger.warn(
            { address, existingChain: existing.chain, incomingChain: chainId },
            "Skipping cross-chain address collision — token already tracked on another chain"
          );
        }
        continue;
      }

      const pair = pickCanonicalPair(pairsByToken, address);
      const liquidityUsd = pair?.liquidity?.usd ?? 0;
      const symbol = pair?.baseToken.symbol ?? "?";
      const name = pair?.baseToken.name ?? symbol;
      // Real launch time when DexScreener reports it, so the momentum window's age check
      // reflects the token's actual age rather than our discovery time.
      const firstSeenAt = pair?.pairCreatedAt && pair.pairCreatedAt > 0 ? pair.pairCreatedAt : now;
      const status = pair && liquidityUsd >= minLiquidityUsd ? "active" : "unindexed";

      tokenRepo.insertIfNew(
        normalizeAddress(address),
        symbol,
        name,
        pair?.pairAddress ?? "",
        status,
        null, // deployer: not exposed by these feeds
        null, // factory: Pons-specific, absent off Robinhood
        firstSeenAt,
        null, // pool address: only captured from Pons launch events
        null,
        null, // launch block: only captured from Pons launch events
        chainId
      );
      if (pair?.info?.imageUrl) tokenRepo.setImageUrlIfMissing(normalizeAddress(address), pair.info.imageUrl);
      inserted += 1;
    }
  }

  if (inserted > 0) {
    logger.info({ inserted, chains: [...byChain.keys()] }, "Multi-chain discovery inserted new tokens");
  }
  return inserted;
}
