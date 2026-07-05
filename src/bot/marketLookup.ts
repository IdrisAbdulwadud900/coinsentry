import { pickCanonicalPair, toMarketSnapshot } from "../data/dexscreener.js";
import type { MarketSnapshot, TokenRow } from "../types/domain.js";
import { getDeps } from "./deps.js";

/** Fetches fresh live market data for an already-known token (used for cards/rule setup). */
export async function fetchLiveMarket(token: TokenRow): Promise<MarketSnapshot | null> {
  const { dex, logger } = getDeps();
  try {
    const pairs = await dex.lookupBatch(token.chain_id, [token.token_address]);
    const match = pairs.find((p) => p.chainId === token.chain_id && p.pairAddress === token.pair_address);
    if (match) return toMarketSnapshot(match, token.token_address);

    // Fall back to the cross-chain lookup in case the batch endpoint temporarily
    // dropped the pair for this token address.
    const fallbackPairs = await dex.lookupAddress(token.token_address);
    const canonical = fallbackPairs.find(
      (p) => p.chainId === token.chain_id && p.pairAddress === token.pair_address
    );
    return canonical ? toMarketSnapshot(canonical, token.token_address) : null;
  } catch (err) {
    logger.error({ tokenId: token.id, err: String(err) }, "fetchLiveMarket failed");
    return null;
  }
}

export { pickCanonicalPair, toMarketSnapshot };
