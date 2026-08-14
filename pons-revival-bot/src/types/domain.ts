/** 'unindexed' = discovered on-chain but DexScreener has no data yet, or liquidity is
 * below the discovery floor, or the deployer is a known spam launcher. Excluded from
 * the main per-cycle market-data lookup; rechecked only in a low-frequency sweep. */
export type TokenStatus = "active" | "dead" | "reviving" | "alerted" | "unindexed";

export interface TokenRow {
  address: string;
  /** DexScreener chainId slug this token lives on ("robinhood", "solana", "bsc",
   * "ethereum"). Rows created before multi-chain support default to "robinhood". */
  chain: string;
  symbol: string;
  name: string;
  pair_address: string;
  first_seen_at: number;
  status: TokenStatus;
  status_changed_at: number;
  last_alert_at: number | null;
  dead_confirm_count: number;
  revival_confirm_count: number;
  demote_confirm_count: number;
  deployer_address: string | null;
  not_indexed_streak: number;
  last_checked_at: number | null;
  factory_address: string | null;
  graduated: number;
  graduation_paired_wei: string | null;
  graduation_threshold_wei: string | null;
  graduation_checked_at: number | null;
  /** Highest index (1-based) of MARKET_CAP_ALERT_TIERS_USD already alerted for this
   * token; 0 means no tier crossed yet. Never decreases. */
  graduation_alert_tier: number;
  /** Number of early-momentum alerts sent for this token so far (capped at 2: the
   * original one-shot alert, plus at most one bounded re-alert). */
  momentum_alert_count: number;
  /** Uniswap V3 pool address for this token's pair, from the TokenLaunched event. Null
   * for legacy rows discovered before this field was captured. */
  pool_address: string | null;
  /** The token this one is paired against in its pool (WETH per Pons docs). */
  pair_token_address: string | null;
  /** ERC20 decimals() for this token, cached once on first successful on-chain read. */
  token_decimals: number | null;
  /** ERC20 totalSupply() for this token, raw on-chain units as a string (mirrors the
   * existing *_wei string pattern), cached once on first successful on-chain read. */
  token_total_supply: string | null;
  /** All-time-high market cap (USD) observed for this token across any snapshot/sweep
   * that successfully resolved a market cap. Null until first resolved. */
  ath_market_cap_usd: number | null;
  /** Market cap (USD) captured at the moment of this token's first-ever alert (any type)
   * — the "entry" baseline for post-alert performance tracking. Set once, never overwritten.
   * For tokens alerted before this feature existed, this is backfilled from the first
   * market cap resolved after deploy rather than their true historical alert-time value,
   * which was never recorded. Null until a baseline has been captured. */
  first_alert_market_cap_usd: number | null;
  /** Timestamp the entry baseline above was captured. */
  first_alert_at: number | null;
  /** Highest (current market cap / first_alert_market_cap_usd) ratio observed since the
   * entry baseline was set. 0 until a baseline exists and at least one comparison is made. */
  peak_multiple: number;
  /** Timestamp the peak multiple above was last updated. */
  peak_multiple_at: number | null;
  /** Highest milestone multiple (from PERFORMANCE_MILESTONE_MULTIPLES) already alerted for
   * this token — never re-fires for an already-crossed milestone. */
  last_milestone_multiple_alerted: number;
  /** Token image/icon URL, cached the first time any sweep observes one from
   * DexScreener. Lets alert paths that never call DexScreener themselves (e.g. the
   * pure-on-chain fast graduation sweep) still show a real, previously-seen image
   * instead of omitting one. Null until first observed — never fabricated. */
  image_url: string | null;
  /** Block number the TokenLaunched event was emitted in, captured at discovery time.
   * Null for legacy rows discovered before this field was captured. Used to bound the
   * early-buy-concentration getLogs window — never backfilled. */
  launch_block: string | null;
  /** Most recent entry-gate skip reason (see entryAlertBlockReason in poller.ts), kept so
   * the missed-winners audit can show why a coin that later did well was never alerted.
   * Null for tokens never blocked. */
  last_block_reason: string | null;
  /** When the entry gate last blocked this token — throttles re-running the gate's
   * DexScreener lookup for a token that keeps getting blocked. */
  last_block_at: number | null;
  /** Timestamp this token last went through the main cycle's market-data lookup. Drives
   * the round-robin scan that bounds each cycle's cost. Null until first checked, which
   * sorts it first so brand-new tokens are never starved. */
  market_checked_at: number | null;
  /** When a breakout alert last fired for this token — its own cooldown, independent of
   * last_alert_at so the two signals never suppress each other. */
  breakout_alerted_at: number | null;
}

export interface SnapshotRow {
  id: number;
  address: string;
  ts: number;
  volume_5m: number | null;
  volume_1h: number | null;
  volume_24h: number | null;
  txns_buys_5m: number | null;
  txns_buys_1h: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
}

export interface AlertRow {
  id: number;
  address: string;
  ts: number;
  dry_run: number;
  volume_1h: number | null;
  buys_1h: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  baseline_median_volume_1h: number | null;
  baseline_median_liquidity_usd: number | null;
  dead_for_hours: number;
}

export interface DiscoveryStateRow {
  factory_address: string;
  last_scanned_block: string; // stored as text since block numbers exceed safe-integer-friendly display but fit in bigint
}

/** Normalized market data for a single token, pulled from a DexScreener pair. */
export interface MarketSnapshot {
  tokenAddress: string;
  pairAddress: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  /** Real market cap in USD, sourced from DexScreener's own marketCap/fdv fields —
   * never fabricated. Null when DexScreener hasn't indexed/reported it yet. */
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5m: number | null;
  volume1h: number | null;
  volume24h: number | null;
  buys5m: number | null;
  buys1h: number | null;
  sells5m: number | null;
  sells1h: number | null;
  /** Token image/icon URL from DexScreener's `info` field. Null when unavailable —
   * never fabricated. Not persisted to the DB; refetched fresh each cycle. */
  imageUrl: string | null;
  /** First website URL from DexScreener's `info.websites`, if any. */
  websiteUrl: string | null;
  /** Social links (e.g. Twitter, Telegram) from DexScreener's `info.socials`, if any. */
  socials: { type: string; url: string }[];
}
