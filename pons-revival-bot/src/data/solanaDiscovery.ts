import type { Logger } from "pino";
import type { TokenRepo } from "./tokenRepo.js";
import type { JupiterClient } from "./jupiterClient.js";

export interface SolanaDiscoveryDeps {
  tokenRepo: TokenRepo;
  jupiter: JupiterClient;
  /** Liquidity floor for tracking a token as 'active' rather than 'unindexed'. */
  minLiquidityUsd: number;
  /** A deployer with more mints than this is a spam farm; its tokens are tracked as
   * 'unindexed' so they stay out of the per-cycle scan (mirrors the Pons spam rule). */
  spamDevMintsThreshold: number;
  logger: Logger;
}

/**
 * Discovers Solana tokens at birth via Jupiter's recent-tokens feed.
 *
 * This exists because DexScreener's cross-chain profile/boost feeds only surface tokens
 * once they're *promoted* — typically well after a run has started. That's how a coin
 * like Dino was first seen at $661k, far past the sub-$11k entry window, and therefore
 * correctly but uselessly blocked by the entry cap. Jupiter reports pools within seconds
 * of creation at ~$2k market cap, which is exactly the window the owner wants to enter.
 *
 * The feed also carries the deployer's lifetime mint count, so obvious spam farms are
 * filtered here rather than burning per-cycle scan budget on them.
 */
export async function runSolanaDiscovery(deps: SolanaDiscoveryDeps): Promise<number> {
  const { tokenRepo, jupiter, minLiquidityUsd, spamDevMintsThreshold, logger } = deps;

  const recent = await jupiter.fetchRecentTokens();
  if (recent.length === 0) return 0;

  const now = Date.now();
  let inserted = 0;
  let spamSkipped = 0;

  for (const token of recent) {
    if (tokenRepo.findByAddress(token.address) !== undefined) continue;

    const isSpamDev = token.devMints != null && token.devMints > spamDevMintsThreshold;
    if (isSpamDev) spamSkipped += 1;

    const hasLiquidity = (token.liquidityUsd ?? 0) >= minLiquidityUsd;
    const status = !isSpamDev && hasLiquidity ? "active" : "unindexed";

    tokenRepo.insertIfNew(
      token.address,
      token.symbol,
      token.name,
      "", // pair address is resolved later from DexScreener, once it indexes the pool
      status,
      token.dev,
      null, // no Pons factory — graduation/bonding-curve tracking correctly skips these
      token.firstPoolCreatedAt ?? now,
      null,
      null,
      null,
      "solana"
    );

    if (token.iconUrl) tokenRepo.setImageUrlIfMissing(token.address, token.iconUrl);
    // Raw on-chain units, matching how every other supply figure is stored, so the
    // holder-concentration math works without a separate conversion path.
    if (token.totalSupply != null && token.totalSupply > 0) {
      const raw = BigInt(Math.round(token.totalSupply * 10 ** token.decimals));
      tokenRepo.setTokenTotalSupplyIfMissing(token.address, raw.toString());
    }
    inserted += 1;
  }

  if (inserted > 0) {
    logger.info({ inserted, spamSkipped, feedSize: recent.length }, "Solana discovery inserted new tokens");
  }
  return inserted;
}
