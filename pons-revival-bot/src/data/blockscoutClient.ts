import type { Logger } from "pino";

const REQUEST_TIMEOUT_MS = 10_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface HolderEntry {
  address: string;
  value: bigint;
}

/** Real, on-chain-observed holder concentration for a token, computed from Blockscout's
 * holders API. `top10Pct` and each `topHolders[].pct` are plain percentages of real
 * supply — never fabricated or estimated. */
export interface HolderConcentration {
  /** Up to 10 largest real holders (pool/token-contract/burn addresses excluded), sorted
   * descending by balance. */
  topHolders: { address: string; pct: number }[];
  /** Combined share of total supply held by `topHolders`, 0-100. */
  top10Pct: number;
}

/**
 * Thin client for Robinhood Chain's official Blockscout explorer API
 * (https://robinhoodchain.blockscout.com/api-docs), used only to read real token holder
 * balances for the "top holders / concentration" alert field. The holders endpoint is
 * free and requires no API key. Returns null on any HTTP/parse failure — never throws,
 * never fabricates data.
 */
export class BlockscoutClient {
  constructor(
    private readonly logger: Logger,
    private readonly baseUrl: string
  ) {}

  /**
   * Fetches up to `maxHolders` holder balances for a token, paginating via Blockscout's
   * cursor-based `next_page_params`. Returns whatever was successfully fetched if a later
   * page fails, or null if the very first request fails.
   */
  async fetchHolders(tokenAddress: string, maxHolders = 60): Promise<HolderEntry[] | null> {
    const holders: HolderEntry[] = [];
    let cursor: Record<string, string> | null = null;

    do {
      const url = new URL(`/api/v2/tokens/${tokenAddress}/holders`, this.baseUrl);
      if (cursor) {
        for (const [key, value] of Object.entries(cursor)) url.searchParams.set(key, value);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          this.logger.warn({ tokenAddress, status: res.status }, "Blockscout holders request failed");
          return holders.length > 0 ? holders : null;
        }
        const body = (await res.json()) as {
          items: { address: { hash: string }; value: string }[];
          next_page_params: Record<string, string> | null;
        };
        for (const item of body.items) {
          holders.push({ address: item.address.hash.toLowerCase(), value: BigInt(item.value) });
        }
        cursor = body.next_page_params;
      } catch (err) {
        this.logger.warn({ tokenAddress, err: String(err) }, "Blockscout holders fetch failed");
        return holders.length > 0 ? holders : null;
      } finally {
        clearTimeout(timeout);
      }
    } while (cursor && holders.length < maxHolders);

    return holders;
  }

  /**
   * Fetches the token's icon URL from Blockscout's token metadata endpoint, used as a
   * fallback alert-image source for tokens DexScreener has no image for. Returns null
   * when Blockscout has no icon or the request fails — never throws.
   */
  async fetchTokenIconUrl(tokenAddress: string): Promise<string | null> {
    return (await this.fetchTokenMeta(tokenAddress))?.iconUrl ?? null;
  }

  /**
   * Reads a token's icon URL and total supply from Blockscout's token endpoint. Total
   * supply matters for chains where this bot has no RPC of its own (Ethereum) — it's what
   * turns raw holder balances into the top-10 concentration percentage. Returns null on
   * any failure; never fabricates.
   */
  async fetchTokenMeta(tokenAddress: string): Promise<{ iconUrl: string | null; totalSupply: bigint | null } | null> {
    const url = new URL(`/api/v2/tokens/${tokenAddress}`, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { icon_url?: string | null; total_supply?: string | null };
      let totalSupply: bigint | null = null;
      if (body.total_supply) {
        try {
          totalSupply = BigInt(body.total_supply);
        } catch {
          totalSupply = null;
        }
      }
      return { iconUrl: body.icon_url || null, totalSupply };
    } catch (err) {
      this.logger.warn({ tokenAddress, err: String(err) }, "Blockscout token metadata fetch failed");
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Ranks real holder balances, excluding known non-investor addresses (the token's own
 * liquidity pool and the token contract itself — neither represents a wallet holding for
 * investment/insider purposes) and the burn/zero address, then returns the top 10 by
 * share of total supply. Returns null when supply is unknown/zero or no real holders
 * remain after exclusion — never fabricates a percentage.
 */
export function computeHolderConcentration(
  holders: HolderEntry[],
  excludeAddresses: (string | null)[],
  totalSupply: bigint
): HolderConcentration | null {
  if (totalSupply <= 0n) return null;
  const excluded = new Set(excludeAddresses.filter((a): a is string => a != null).map((a) => a.toLowerCase()));
  const real = holders.filter((h) => !excluded.has(h.address) && h.address !== ZERO_ADDRESS);
  if (real.length === 0) return null;

  const sorted = [...real].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const top10 = sorted.slice(0, 10);
  const top10Value = top10.reduce((sum, h) => sum + h.value, 0n);

  return {
    topHolders: top10.map((h) => ({ address: h.address, pct: (Number(h.value) / Number(totalSupply)) * 100 })),
    top10Pct: (Number(top10Value) / Number(totalSupply)) * 100,
  };
}
