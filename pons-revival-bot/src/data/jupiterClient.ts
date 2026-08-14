import { z } from "zod";
import type { Logger } from "pino";
import type { SolanaMintSafety } from "./solanaClient.js";

const BASE_URL = "https://lite-api.jup.ag";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A freshly-created Solana token as reported by Jupiter's recent-tokens feed.
 *
 * This is the only free, keyless source found that surfaces Solana tokens *at birth*
 * (measured: ~6 seconds after pool creation, at ~$2k market cap) rather than after they
 * have already run. DexScreener's profile/boost feeds only list promoted tokens, which is
 * why a coin like Dino was first seen at $661k — long past the sub-$11k entry window.
 */
export interface JupiterRecentToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
  /** Deployer wallet. */
  dev: string | null;
  /** Which launchpad minted it (e.g. "pump.fun"), when known. */
  launchpad: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  /** Human-unit total supply, as reported. */
  totalSupply: number | null;
  /** Pool creation time — the token's real birth timestamp. */
  firstPoolCreatedAt: number | null;
  /** How many tokens this deployer has ever minted; a spam-farm tell at high values. */
  devMints: number | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
}

const RecentTokenSchema = z.object({
  id: z.string(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  decimals: z.number().optional(),
  icon: z.string().optional(),
  dev: z.string().optional(),
  launchpad: z.string().nullish(),
  mcap: z.number().nullish(),
  liquidity: z.number().nullish(),
  totalSupply: z.number().nullish(),
  firstPool: z.object({ createdAt: z.string().optional() }).nullish(),
  audit: z
    .object({
      mintAuthorityDisabled: z.boolean().nullish(),
      freezeAuthorityDisabled: z.boolean().nullish(),
      devMints: z.number().nullish(),
    })
    .nullish(),
});
const RecentTokenArraySchema = RecentTokenSchema.array();

/** Thin client for Jupiter's free token API. Returns [] on any failure — a bad fetch
 * never aborts a poll cycle, and nothing here is ever fabricated. */
export class JupiterClient {
  constructor(private readonly logger: Logger) {}

  async fetchRecentTokens(): Promise<JupiterRecentToken[]> {
    try {
      const res = await fetch(`${BASE_URL}/tokens/v2/recent`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "Jupiter recent-tokens request failed");
        return [];
      }
      const parsed = RecentTokenArraySchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.error({ issues: parsed.error.issues.slice(0, 3) }, "Failed to parse Jupiter recent-tokens response");
        return [];
      }

      return parsed.data.map((t) => {
        const created = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : NaN;
        return {
          address: t.id,
          symbol: t.symbol || "?",
          name: t.name || t.symbol || "Unknown",
          decimals: t.decimals ?? 6,
          iconUrl: t.icon ?? null,
          dev: t.dev ?? null,
          launchpad: t.launchpad ?? null,
          marketCapUsd: t.mcap ?? null,
          liquidityUsd: t.liquidity ?? null,
          totalSupply: t.totalSupply ?? null,
          firstPoolCreatedAt: Number.isFinite(created) ? created : null,
          devMints: t.audit?.devMints ?? null,
          mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
          freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
        };
      });
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Jupiter recent-tokens fetch threw");
      return [];
    }
  }

  /**
   * Looks up a single mint's safety profile at alert time: authority status, holder
   * concentration, holder count and Jupiter's organic-activity rating.
   *
   * This is what makes Solana alerts carry the same safety fields as Robinhood ones. The
   * equivalent on-chain read (`getTokenLargestAccounts`) is hard-throttled on every free
   * public RPC, so this endpoint is the only keyless way to get concentration data.
   * Returns null on any failure — the caller then omits the lines rather than guessing.
   */
  async fetchTokenSafety(mintAddress: string): Promise<SolanaMintSafety | null> {
    try {
      const res = await fetch(`${BASE_URL}/tokens/v2/search?query=${encodeURIComponent(mintAddress)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const parsed = SafetyLookupSchema.safeParse(await res.json());
      if (!parsed.success) return null;

      // The search endpoint is fuzzy, so only trust an exact mint match.
      const hit = parsed.data.find((t) => t.id === mintAddress);
      const audit = hit?.audit;
      if (!hit || !audit) return null;
      // Authority status is the one field that must be known to be useful — "unknown"
      // must never be reported as safe.
      if (audit.mintAuthorityDisabled == null && audit.freezeAuthorityDisabled == null) return null;

      return {
        mintAuthorityActive: audit.mintAuthorityDisabled === false,
        freezeAuthorityActive: audit.freezeAuthorityDisabled === false,
        topHoldersPct: audit.topHoldersPercentage ?? null,
        holderCount: hit.holderCount ?? null,
        organicScoreLabel: hit.organicScoreLabel ?? null,
        iconUrl: hit.icon ?? null,
      };
    } catch (err) {
      this.logger.warn({ mintAddress, err: String(err) }, "Jupiter token-safety lookup failed");
      return null;
    }
  }
}

const SafetyLookupSchema = z
  .object({
    id: z.string(),
    icon: z.string().nullish(),
    holderCount: z.number().nullish(),
    organicScoreLabel: z.string().nullish(),
    audit: z
      .object({
        mintAuthorityDisabled: z.boolean().nullish(),
        freezeAuthorityDisabled: z.boolean().nullish(),
        topHoldersPercentage: z.number().nullish(),
      })
      .nullish(),
  })
  .array();
