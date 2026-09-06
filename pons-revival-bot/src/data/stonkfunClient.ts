import type { Logger } from "pino";

/** One launch from StonkFun's public ledger. Only the fields the bot acts on are modelled —
 * the API returns considerably more per token. */
export interface StonkfunLaunch {
  /** Solana mint address. Base58 and case-sensitive — never lower-case it. */
  mint: string;
  /** Liquidity pool address, used to match the coin from trading activity later. */
  pool: string | null;
  name: string;
  symbol: string;
  createdAt: number | null;
  startMarketCapUsd: number | null;
}

interface LaunchesResponse {
  data?: {
    launches?: {
      mint?: string;
      pool?: string | null;
      name?: string;
      symbol?: string;
      createdAt?: string;
      startMarketCapUsd?: number | null;
    }[];
    pagination?: { page?: number; pageSize?: number; total?: number; totalPages?: number };
  };
}

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Reads StonkFun's launch ledger — the Solana equivalent of watching a launchpad factory.
 *
 * Solana has no eth_getLogs or event topics, so none of the EVM launch-scanning machinery
 * transfers. StonkFun publishes a public REST ledger instead, which is a better source than
 * program-log parsing would be: it is authoritative, needs no RPC, and page 1 is ordered
 * newest-first, so polling that one page catches every launch. Measured, a page of 25 spans
 * roughly 16 minutes, which leaves a wide margin over any poll interval this bot uses.
 *
 * Coins list at about $2,800-$3,000 of market cap, so this feed reaches them at the very
 * bottom — before any move, which is the only place an alert is worth having.
 */
export class StonkfunClient {
  constructor(
    private readonly logger: Logger,
    private readonly apiBase: string
  ) {}

  /**
   * Newest launches first. Returns null on failure rather than an empty list, so a caller
   * can tell "the API is down" from "nothing has launched" — treating the first as the
   * second would silently stop discovery.
   */
  async fetchLaunches(page = 1): Promise<StonkfunLaunch[] | null> {
    const url = `${this.apiBase}/launches?page=${page}`;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, page }, "StonkFun launches request failed");
        return null;
      }
      const body = (await res.json()) as LaunchesResponse;
      const launches = body.data?.launches;
      if (!Array.isArray(launches)) {
        this.logger.warn({ page }, "StonkFun launches response had no launches array");
        return null;
      }
      const out: StonkfunLaunch[] = [];
      for (const raw of launches) {
        if (!raw.mint) continue;
        const createdAt = raw.createdAt ? Date.parse(raw.createdAt) : NaN;
        out.push({
          mint: raw.mint,
          pool: raw.pool ?? null,
          name: raw.name ?? raw.symbol ?? "Unknown",
          symbol: raw.symbol ?? "?",
          createdAt: Number.isFinite(createdAt) ? createdAt : null,
          startMarketCapUsd: raw.startMarketCapUsd ?? null,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn({ err: String(err), page }, "StonkFun launches request errored");
      return null;
    }
  }
}
