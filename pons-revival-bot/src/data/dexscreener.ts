import { z } from "zod";
import type { Logger } from "pino";
import { DexPairArraySchema, type DexPair } from "../types/dexscreener.js";
import type { MarketSnapshot } from "../types/domain.js";
import { normalizeAddress } from "./chains.js";

const BASE_URL = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_ADDRESSES_PER_BATCH = 30;

export class DexScreenerError extends Error {}

export class DexScreenerClient {
  /** Timestamp (ms) of the next request slot this client is allowed to use. Shared across
   * all concurrent workers so the combined request rate (including retries) never exceeds
   * `requestsPerMinute`, no matter how many workers are running. */
  private nextSlotAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly concurrency: number = 4,
    private readonly requestsPerMinute: number = 250
  ) {}

  /** Reserves the next allowed request slot and waits for it. Synchronous reservation
   * (no await between read and write of nextSlotAt) avoids a race between workers. */
  private async acquireSlot(): Promise<void> {
    const intervalMs = 60_000 / this.requestsPerMinute;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + intervalMs;
    const wait = slot - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private async fetchWithRetry(url: string): Promise<unknown> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= MAX_RETRIES) {
      await this.acquireSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
        clearTimeout(timeout);

        if (res.status === 429 || res.status >= 500) {
          throw new DexScreenerError(`DexScreener responded ${res.status} for ${url}`);
        }
        if (!res.ok) {
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
        this.logger.warn({ url, attempt, delay, err: String(err) }, "DexScreener request failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new DexScreenerError(String(lastError));
  }

  /**
   * Batch-fetches pairs for up to 30 token addresses on a single chain per call.
   * Chunks automatically if given more, running up to `concurrency` chunk requests
   * in flight at once for latency-hiding, but all request starts (including retries)
   * are globally paced to `requestsPerMinute` via `acquireSlot` so the real DexScreener
   * rate limit is respected regardless of `concurrency`. Failures in one chunk are
   * logged and skipped rather than aborting the whole batch.
   */
  async lookupBatch(chainId: string, tokenAddresses: string[]): Promise<DexPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < tokenAddresses.length; i += MAX_ADDRESSES_PER_BATCH) {
      chunks.push(tokenAddresses.slice(i, i + MAX_ADDRESSES_PER_BATCH));
    }

    const results: DexPair[] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        if (!chunk) continue;

        const joined = chunk.map(encodeURIComponent).join(",");
        const url = `${BASE_URL}/tokens/v1/${encodeURIComponent(chainId)}/${joined}`;
        try {
          const json = await this.fetchWithRetry(url);
          const parsed = DexPairArraySchema.safeParse(json);
          if (!parsed.success) {
            this.logger.error(
              { chainId, chunk, issues: parsed.error.issues },
              "Failed to parse DexScreener batch response"
            );
            continue;
          }
          results.push(...parsed.data);
        } catch (err) {
          this.logger.error({ chainId, chunk, err: String(err) }, "DexScreener batch lookup failed");
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, chunks.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  /**
   * Fetches DexScreener's two cross-chain discovery feeds (latest token profiles and
   * latest boosts) and returns their combined, de-duplicated contents. This is the
   * multi-chain equivalent of the Robinhood-only on-chain factory scan: it's the only
   * free, key-less source that surfaces brand-new tokens across Solana/BSC/Ethereum.
   * Feed failures are logged and skipped — a bad fetch never aborts a poll cycle.
   */
  async fetchDiscoveryFeeds(): Promise<DexTokenProfile[]> {
    const urls = [`${BASE_URL}/token-profiles/latest/v1`, `${BASE_URL}/token-boosts/latest/v1`];
    const byKey = new Map<string, DexTokenProfile>();

    for (const url of urls) {
      try {
        const json = await this.fetchWithRetry(url);
        const parsed = TokenProfileArraySchema.safeParse(json);
        if (!parsed.success) {
          this.logger.error({ url, issues: parsed.error.issues.slice(0, 3) }, "Failed to parse DexScreener discovery feed");
          continue;
        }
        for (const item of parsed.data) {
          const key = `${item.chainId}:${item.tokenAddress}`;
          if (byKey.has(key)) continue;
          byKey.set(key, {
            chainId: item.chainId,
            tokenAddress: item.tokenAddress,
            icon: item.icon,
            links: (item.links ?? []).map((l) => ({ type: l.type ?? l.label ?? "link", url: l.url })),
          });
        }
      } catch (err) {
        this.logger.warn({ url, err: String(err) }, "DexScreener discovery feed fetch failed");
      }
    }

    return [...byKey.values()];
  }
}

/** A newly listed/boosted token from DexScreener's cross-chain discovery feeds. These
 * feeds are how this bot finds tokens on chains where it has no contract-level launch
 * discovery (everything except Robinhood/Pons). Tokens here always carry real links,
 * which is exactly the universe the entry gate requires anyway. */
export interface DexTokenProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  links: { type: string; url: string }[];
}

const TokenProfileSchema = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
  icon: z.string().optional(),
  links: z
    .array(z.object({ type: z.string().optional(), label: z.string().optional(), url: z.string() }))
    .optional(),
});
const TokenProfileArraySchema = TokenProfileSchema.array();

/**
 * Groups a `lookupBatch` result by lowercased base token address so `pickCanonicalPair`
 * can look up a token's pairs in O(1) instead of re-scanning the whole array per token.
 * Build once per batch and reuse across every token in that batch.
 */
export function indexPairsByToken(pairs: DexPair[]): Map<string, DexPair[]> {
  const index = new Map<string, DexPair[]>();
  for (const pair of pairs) {
    const key = normalizeAddress(pair.baseToken.address);
    const existing = index.get(key);
    if (existing) {
      existing.push(pair);
    } else {
      index.set(key, [pair]);
    }
  }
  return index;
}

/** Picks the pair with the highest USD liquidity for a given base token address (a token can have multiple pools). */
export function pickCanonicalPair(pairsByToken: Map<string, DexPair[]>, tokenAddress: string): DexPair | undefined {
  const matches = pairsByToken.get(normalizeAddress(tokenAddress));
  if (!matches || matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return [...matches].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export function toMarketSnapshot(pair: DexPair, tokenAddress: string): MarketSnapshot {
  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
  // Prefer DexScreener's own circulating market cap; fall back to FDV. Pons tokens have a
  // fixed, non-vesting total supply per the launchpad docs, so fdv≈marketCap here anyway —
  // this fallback just covers cases where DexScreener hasn't populated `marketCap` yet.
  const marketCapUsd = pair.marketCap ?? pair.fdv ?? null;
  return {
    tokenAddress,
    pairAddress: pair.pairAddress,
    symbol: pair.baseToken.symbol ?? "?",
    name: pair.baseToken.name ?? pair.baseToken.symbol ?? "Unknown",
    priceUsd: priceUsd !== null && Number.isFinite(priceUsd) ? priceUsd : null,
    marketCapUsd: marketCapUsd !== null && Number.isFinite(marketCapUsd) ? marketCapUsd : null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume5m: pair.volume?.m5 ?? null,
    volume1h: pair.volume?.h1 ?? null,
    volume24h: pair.volume?.h24 ?? null,
    buys5m: pair.txns?.m5?.buys ?? null,
    buys1h: pair.txns?.h1?.buys ?? null,
    sells5m: pair.txns?.m5?.sells ?? null,
    sells1h: pair.txns?.h1?.sells ?? null,
    imageUrl: pair.info?.imageUrl ?? null,
    websiteUrl: pair.info?.websites?.[0]?.url ?? null,
    socials: (pair.info?.socials ?? []).map((s) => ({ type: s.type ?? "link", url: s.url })),
  };
}
