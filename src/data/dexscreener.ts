import type { Logger } from "pino";
import { DexPairSchema, DexTokensResponseSchema, type DexPair } from "../types/dexscreener.js";
import type { MarketSnapshot } from "../types/domain.js";

const BASE_URL = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_ADDRESSES_PER_BATCH = 30;

export class DexScreenerError extends Error {}

async function fetchWithRetry(url: string, logger: Logger): Promise<unknown> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      clearTimeout(timeout);

      if (res.status === 429 || res.status >= 500) {
        throw new DexScreenerError(`DexScreener responded ${res.status} for ${url}`);
      }
      if (!res.ok) {
        // 4xx other than 429: treat as non-retryable (e.g. malformed address).
        throw new DexScreenerError(`DexScreener responded ${res.status} for ${url} (non-retryable)`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;

      const nonRetryable = err instanceof DexScreenerError && err.message.includes("non-retryable");
      if (nonRetryable || attempt === MAX_RETRIES) {
        break;
      }

      const backoffMs = 2 ** attempt * 500;
      const jitterMs = Math.floor(Math.random() * 250);
      const delay = backoffMs + jitterMs;
      logger.warn({ url, attempt, delay, err: String(err) }, "DexScreener request failed, retrying");
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new DexScreenerError(String(lastError));
}

export class DexScreenerClient {
  constructor(private readonly logger: Logger) {}

  /**
   * Looks up a single contract address across all chains DexScreener indexes.
   * Used when a user first pastes a CA and we need to auto-detect its chain.
   */
  async lookupAddress(address: string): Promise<DexPair[]> {
    const url = `${BASE_URL}/latest/dex/tokens/${encodeURIComponent(address)}`;
    const json = await fetchWithRetry(url, this.logger);
    const parsed = DexTokensResponseSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.error({ issues: parsed.error.issues }, "Failed to parse DexScreener tokens response");
      return [];
    }
    return parsed.data.pairs ?? [];
  }

  /**
   * Batch-fetches pairs for up to 30 token addresses on a single chain in one call.
   * Chunks automatically if given more than 30 addresses.
   */
  async lookupBatch(chainId: string, tokenAddresses: string[]): Promise<DexPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < tokenAddresses.length; i += MAX_ADDRESSES_PER_BATCH) {
      chunks.push(tokenAddresses.slice(i, i + MAX_ADDRESSES_PER_BATCH));
    }

    const results: DexPair[] = [];
    for (const chunk of chunks) {
      const joined = chunk.map(encodeURIComponent).join(",");
      const url = `${BASE_URL}/tokens/v1/${encodeURIComponent(chainId)}/${joined}`;
      try {
        const json = await fetchWithRetry(url, this.logger);
        const arraySchema = DexPairSchema.array();
        const parsed = arraySchema.safeParse(json);
        if (!parsed.success) {
          this.logger.error(
            { chainId, chunk, issues: parsed.error.issues },
            "Failed to parse DexScreener batch response"
          );
          continue;
        }
        results.push(...parsed.data);
      } catch (err) {
        // Never let one failing chain/chunk break the whole poll loop.
        this.logger.error({ chainId, chunk, err: String(err) }, "DexScreener batch lookup failed");
      }
    }
    return results;
  }
}

/** Picks the pair with the highest USD liquidity from a list of candidate pairs. */
export function pickCanonicalPair(pairs: DexPair[]): DexPair | undefined {
  if (pairs.length === 0) return undefined;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

/** Converts a raw DexScreener pair into our normalized MarketSnapshot, given the token address we care about. */
export function toMarketSnapshot(pair: DexPair, tokenAddress: string): MarketSnapshot {
  const lowerTarget = tokenAddress.toLowerCase();
  const baseMatches =
    pair.baseToken.address === tokenAddress || pair.baseToken.address.toLowerCase() === lowerTarget;
  const identity = baseMatches ? pair.baseToken : pair.quoteToken ?? pair.baseToken;

  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : NaN;

  return {
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    tokenAddress: identity.address,
    symbol: identity.symbol ?? "?",
    name: identity.name ?? identity.symbol ?? "Unknown",
    pairUrl: pair.url ?? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    mcap: pair.marketCap ?? pair.fdv ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volumeM5: pair.volume?.m5 ?? null,
    volumeH1: pair.volume?.h1 ?? null,
    volumeH24: pair.volume?.h24 ?? null,
    priceChangeM5: pair.priceChange?.m5 ?? null,
    priceChangeH1: pair.priceChange?.h1 ?? null,
    priceChangeH6: pair.priceChange?.h6 ?? null,
    priceChangeH24: pair.priceChange?.h24 ?? null,
  };
}
