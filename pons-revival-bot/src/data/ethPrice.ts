import type { Logger } from "pino";

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Small in-memory-cached ETH/USD price fetcher (mirrors DexScreenerClient's style:
 * native fetch, own class). Used to convert on-chain ETH amounts (e.g. bonding-curve
 * `pairedPrincipal`) into a USD figure for alert tiering. On fetch failure, keeps
 * serving the last known price (graceful degradation) rather than throwing — callers
 * that get `null` back (never successfully fetched) should skip USD-denominated
 * alerts for that cycle instead of fabricating a price.
 */
export class EthPriceClient {
  private cachedPrice: number | null = null;
  private cachedAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly ttlMs: number
  ) {}

  async getUsdPrice(): Promise<number | null> {
    const now = Date.now();
    if (this.cachedPrice !== null && now - this.cachedAt < this.ttlMs) {
      return this.cachedPrice;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(COINGECKO_URL, { signal: controller.signal, headers: { accept: "application/json" } });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`CoinGecko responded ${res.status}`);
      }
      const json = (await res.json()) as { ethereum?: { usd?: number } };
      const price = json.ethereum?.usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        throw new Error("CoinGecko response missing a valid ethereum.usd price");
      }
      this.cachedPrice = price;
      this.cachedAt = now;
      return price;
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        { err: String(err), lastKnownPrice: this.cachedPrice },
        "ETH/USD price fetch failed, falling back to last known price"
      );
      return this.cachedPrice;
    }
  }
}
