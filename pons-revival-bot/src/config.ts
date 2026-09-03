import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),

  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  // Maintenance switch. With this false the bot boots, serves its API and answers Telegram
  // commands but starts no polling, which is what makes it possible to repair or prune the
  // database on a live machine — the alternative is racing a crash-looping poller for a
  // shell. Never leave it false: nothing is discovered and no alert can fire.
  // Enum rather than z.coerce.boolean(): coercion is Boolean("false") === true, so the
  // string "false" would switch the flag ON and quietly defeat the whole point of it.
  POLLING_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),

  // The fast poller catches a launch within seconds of it happening — the measured
  // best-performing alert bucket is coins under 5 minutes old, which only this loop can
  // reach. It was off while new pairs were out of scope and while the unindexed sweep it
  // shares could materialise 400k rows in one read (the crash the whole hunt was chasing);
  // that read is now hard-capped, and new pairs are targets again.
  FAST_POLLING_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),

  DEAD_MIN_AGE_HOURS: z.coerce.number().positive().default(24),
  DEAD_VOLUME_24H_USD: z.coerce.number().nonnegative().default(500),
  DEAD_MIN_BUYS_1H: z.coerce.number().int().nonnegative().default(3),
  DEAD_CONFIRM_POLLS: z.coerce.number().int().positive().default(6),

  REVIVAL_VOLUME_MULTIPLE: z.coerce.number().positive().default(8),
  REVIVAL_MIN_VOLUME_1H_USD: z.coerce.number().nonnegative().default(300),
  REVIVAL_MIN_BUYS_1H: z.coerce.number().int().nonnegative().default(5),
  REVIVAL_LIQUIDITY_FLOOR_PCT: z.coerce.number().min(0).max(1).default(0.8),
  REVIVAL_CONFIRM_POLLS: z.coerce.number().int().positive().default(2),
  ALERT_COOLDOWN_HOURS: z.coerce.number().positive().default(6),
  DEMOTE_CONFIRM_POLLS: z.coerce.number().int().positive().default(3),

  // Was 7 days, which accumulated 4.4M snapshot rows and a 908MB database on a 1GB volume
  // until writes failed with "database or disk is full" and the bot crash-looped for ~31
  // hours. Nothing reads snapshots older than a couple of days: the classifier's baselines
  // and the breakout detector both work from recent windows, and the observer's 1h/6h/24h
  // checkpoints live in alert_outcomes, not here.
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().positive().default(3),

  ROBINHOOD_CHAIN_ID_DEXSCREENER: z.string().min(1).default("robinhood"),
  // Chains to track, as DexScreener chainId slugs (see src/data/chains.ts). Robinhood is
  // discovered from Pons factory events on-chain; every other chain is discovered from
  // DexScreener's cross-chain profile/boost feeds. Graduation/bundle%/dev-wallet lines are
  // Pons-specific and appear on Robinhood only; holders appear wherever a Blockscout
  // instance is configured (Robinhood + Ethereum by default), and Solana additionally gets
  // SPL mint/freeze-authority safety checks.
  ENABLED_CHAINS: z.string().min(1).default("robinhood,solana,bsc,ethereum,hyperevm"),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  // Robinhood Chain's official Blockscout explorer, used only to read real token holder
  // balances (free, no API key) for the "top 10 holders / concentration" alert field.
  BLOCKSCOUT_API_BASE_URL: z.string().url().default("https://robinhoodchain.blockscout.com"),
  // Free, keyless Blockscout instance for Ethereum, used for the top-10-holders line on
  // ETH tokens. BSC has no free keyless equivalent, so BSC alerts omit that line; set
  // BSC_BLOCKSCOUT_URL to any Blockscout-compatible endpoint to switch it on.
  ETHEREUM_BLOCKSCOUT_URL: z.string().url().default("https://eth.blockscout.com"),
  BSC_BLOCKSCOUT_URL: z.string().url().optional().or(z.literal("")).default(""),
  // Solana JSON-RPC, used only for SPL mint/freeze authority safety checks at alert time.
  // The default public endpoint serves these light calls without a key.
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  // A Solana deployer with more lifetime mints than this is a spam farm (Jupiter reports
  // the count per token; values in the hundreds are routine for mass minters).
  SOLANA_SPAM_DEV_MINTS: z.coerce.number().int().positive().default(50),
  // Lowest alert conviction to deliver (see rateConviction in poller.ts, derived from
  // measured win rates). "low" keeps full coverage — nothing is suppressed. Set "high"
  // for the ~82%-win-rate stream only (Robinhood, alerted within 5 min of launch), or
  // "medium" to drop just the early-Solana bucket that dumps ~55% of the time.
  MIN_ALERT_CONVICTION: z.enum(["low", "medium", "high"]).default("low"),
  // Breakout signal: a coin accelerating against its own trailing baseline, at any age.
  // This is the path that catches the 2k->high move when it happens hours or days after
  // launch, which every other alert path structurally misses.
  BREAKOUT_VOLUME_MULTIPLE: z.coerce.number().positive().default(5),
  BREAKOUT_MIN_VOLUME_1H_USD: z.coerce.number().nonnegative().default(3000),
  BREAKOUT_MIN_BUYS_1H: z.coerce.number().int().nonnegative().default(30),
  BREAKOUT_COOLDOWN_HOURS: z.coerce.number().positive().default(12),
  // How far price must climb off the sampled low to count as reversing off the floor.
  // 1.4 = 40% up from the bottom: enough to distinguish a real turn from tick noise,
  // low enough to catch the move while it is still worth catching.
  REVERSAL_MULTIPLE: z.coerce.number().positive().default(1.4),
  PONS_FACTORY_ACTIVE: z.string().min(1),
  PONS_FACTORY_ACTIVE_START_BLOCK: z.coerce.number().int().nonnegative(),
  PONS_FACTORY_LEGACY: z.string().min(1),
  PONS_FACTORY_LEGACY_START_BLOCK: z.coerce.number().int().nonnegative(),
  DISCOVERY_CHUNK_BLOCKS: z.coerce.number().int().positive().default(500_000),
  // Launches one discovery pass may hold before deferring the rest to the next cycle. The
  // scan used to run unbounded to the chain head, which is fine while the bot is keeping up
  // and fatal once it is not: a multi-day backlog on Robinhood pinned ~511MB of live
  // objects and the process died on its heap limit every cycle. See scanTokenLaunches.
  DISCOVERY_MAX_LAUNCHES_PER_CYCLE: z.coerce.number().int().positive().default(2_000),
  // Watch the chain's DEX pool factories directly, not just the Pons launchpad. Most
  // Robinhood tokens are launched straight onto a DEX and never touch Pons, so without
  // this they were completely invisible (see src/data/dexPoolDiscovery.ts).
  DEX_POOL_DISCOVERY_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Restricts every scan and alert to coins from the two Pons launchpad factories (v1 and
  // v2). Watching the chain's DEX pools directly pulled in essentially the whole chain —
  // 458,000 tokens against roughly 20,000 launchpad coins — and the per-cycle budget was
  // spread across all of it, so launchpad coins were revisited rarely. With this on, the
  // budget covers the launchpad repeatedly instead of the chain thinly.
  PONS_LAUNCHPAD_ONLY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Narrow further to a single launchpad version. Set to the v2 factory address in
  // production: v1 is retired and its 1,739 coins are almost entirely dead, so scanning
  // them spends budget that belongs to the launchpad still minting ~18.7k coins a day.
  // Regex-constrained because this value is interpolated into a SQL fragment (the filter
  // varies the statement shape, so it cannot be a bound parameter). Restricting it to a
  // 0x-prefixed 20-byte hex address makes anything injectable fail to load at startup.
  // Chunks of ~600 blocks the swap-activity scan covers per fast cycle. The fast cycle runs
  // every 20s and 600 blocks is ~60s of chain, so 4 chunks (~4 minutes of chain) keeps the
  // scan comfortably ahead of real time and absorbs a backlog after any downtime.
  SWAP_SCAN_MAX_CHUNKS_PER_CYCLE: z.coerce.number().int().positive().default(4),
  PONS_FACTORY_FILTER: z
    .string()
    .regex(/^(0x[a-fA-F0-9]{40})?$/, "PONS_FACTORY_FILTER must be a 0x address or empty")
    .default(""),
  // Bearer token for X (Twitter) API v2 recent search, used to list the accounts that have
  // posted a coin's contract address. X removed free search access in 2023, so this needs a
  // paid tier; left blank, alerts simply omit the section rather than implying nobody has
  // posted about a coin when the truth is that we could not look.
  X_BEARER_TOKEN: z.string().optional().or(z.literal("")).default(""),
  // Blocks per getLogs call for the pool scan. ~101ms blocks means 20k ≈ 34 minutes, and
  // this RPC serves that range comfortably.
  DEX_POOL_CHUNK_BLOCKS: z.coerce.number().int().positive().default(20_000),
  // Public, keyless RPCs for the BSC/Ethereum pool scans (both verified serving eth_getLogs
  // on 2026-08-04). Leave either blank to stop scanning that chain.
  BSC_RPC_URL: z.string().url().optional().or(z.literal("")).default("https://bsc-rpc.publicnode.com"),
  ETHEREUM_RPC_URL: z.string().url().optional().or(z.literal("")).default("https://eth.drpc.org"),
  // Two earlier choices both failed in ways that silently disabled this chain: drpc.org
  // does not implement eth_blockNumber at all (HTTP 400), so discovery could never read the
  // chain head; and Hyperliquid's own rpc.hyperliquid.xyz/evm returns -32005 "rate limited"
  // under this bot's steady polling. This endpoint served 80 consecutive getLogs calls with
  // no errors. It still caps ranges at 1,000 blocks, which the 900-block chunk fits.
  HYPEREVM_RPC_URL: z.string().url().optional().or(z.literal("")).default("https://rpc.hypurrscan.io"),
  // How far back to look the first time a pool source is scanned (~1h at 101ms blocks).
  DEX_POOL_BACKFILL_BLOCKS: z.coerce.number().int().positive().default(36_000),

  // Consecutive cycles an 'active' token may return no DexScreener data before it is
  // demoted to 'unindexed'. Without this the active set fills with tokens that were
  // indexed once and never again (measured: 80% of it), and the per-cycle request budget
  // is spent on them instead of on coins that actually trade.
  NO_MARKET_DATA_DEMOTE_STREAK: z.coerce.number().int().positive().default(3),
  // Liquidity must be at least this percent of market cap for the market cap to be
  // believed. Market cap is derived from pool price, so a drained pool reports nonsense —
  // one observed coin showed a $66,194 market cap on $0.02 of liquidity and recorded a
  // $66 BILLION all-time high, which also mislabelled it a "winner" for the observer.
  MIN_LIQUIDITY_TO_MCAP_PCT: z.coerce.number().nonnegative().default(2),

  DISCOVERY_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(200),
  // Number of blocks after a token's launch to scan for real DEX buys (Transfer events
  // from the token's own pool) when computing early-buy-concentration ("bundle %").
  EARLY_BUY_WINDOW_BLOCKS: z.coerce.number().int().positive().default(500),
  SPAM_DEPLOYER_THRESHOLD: z.coerce.number().int().positive().default(15),
  UNINDEXED_RECHECK_HOURS: z.coerce.number().positive().default(24),
  // Max graduationStatus() calls aggregated into a single multicall3 RPC request.
  // 300 is a conservative default kept well under typical eth_call response-size
  // limits; it hasn't been empirically pushed to this RPC's actual ceiling the way
  // DISCOVERY_CHUNK_BLOCKS has, so raise cautiously if larger batches are needed.
  GRADUATION_CHECK_BATCH_SIZE: z.coerce.number().int().positive().default(300),
  // Max tokens the main poll cycle pulls market data for per pass (see
  // listTrackableForCycle: dead/alerted revival candidates first, then actives
  // round-robin). Bounds the cycle's DexScreener cost so it stays inside
  // POLL_INTERVAL_SECONDS instead of overrunning as the token table grows; the whole
  // trackable set is still covered, just across consecutive cycles. At the default
  // 250 req/min and 30 addresses per request, 50,000 tokens ≈ 6.7 minutes of API time.
  MARKET_SCAN_BATCH_SIZE: z.coerce.number().int().positive().default(50_000),
  // Rows the unindexed recheck sweep promotes per slow cycle.
  //
  // This is the single biggest determinant of what the bot can see at all: an 'unindexed'
  // coin is not in the market scan, so it CANNOT alert until this sweep finds DexScreener
  // data for it. With 199,867 unindexed Pons coins and the old budget of 600, a full pass
  // took ~1.2 days — a coin that started running while queued was invisible until its turn
  // came, which is exactly how 5x/10x/20x moves were being missed outright.
  //
  // 8,000 = ~267 DexScreener requests (30 addresses each) per cycle. The limit is 250/min,
  // i.e. 1,250 per 5-minute cycle, and the whole cycle currently uses ~87 of them in 34s of
  // a 300s budget. A full pass now takes ~2 hours instead of ~1.2 days.
  UNINDEXED_SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(8_000),
  DEXSCREENER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  DEXSCREENER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(250),

  // Fast early-detection loop (separate from the main POLL_INTERVAL_SECONDS cycle):
  // runs discovery + a bounded-recency ungraduated sweep + a bounded-recency momentum
  // sweep on a much shorter interval, so brand-new tokens surface within seconds
  // instead of waiting for the next full cycle.
  FAST_DISCOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  // Recency window bounding both fast sweeps below, so their query/RPC cost stays
  // constant regardless of how large the total historical token count grows.
  UNGRADUATED_FAST_WINDOW_HOURS: z.coerce.number().positive().default(6),
  // Ascending USD tiers of real market cap (resolved via DexScreener when indexed,
  // else via on-chain pool price — never fabricated) for a token's fast sweep. One
  // combined alert per newly-crossed tier, never re-fired for an already-crossed tier.
  // Spans both pre- and post-graduation, since real market cap stays meaningful
  // across that boundary (unlike the old "ETH raised into curve" figure).
  // Tiers above the hardcoded $11k entry-alert market-cap cap (see poller.ts's
  // MAX_ALERT_MARKET_CAP_USD) can never fire, so the ladder stops at 10000. It also no
  // longer starts at 2000: measured against production, every Pons launch is born at
  // ~$2,580 market cap, so a $2,000 tier was crossed by 100% of tokens at birth before a
  // single trade — pure noise that also burned a DexScreener lookup per token per cycle.
  MARKET_CAP_ALERT_TIERS_USD: z.string().min(1).default("3000,4000,5000,6000,10000"),
  // Was 60, pairing with a "first hour of a new pair" strategy. That strategy is retired:
  // nothing under MIN_ALERT_AGE_MINUTES (60) can alert at all now, so a 60-minute ceiling
  // left this path with an empty window and it could never fire. Widened to a week, the
  // same burst-of-buying detector applies to established coins instead, which is the
  // "people suddenly bidding" signal that replaced new-pair hunting.
  EARLY_MOMENTUM_MAX_AGE_MINUTES: z.coerce.number().positive().default(10_080),
  EARLY_MOMENTUM_MIN_BUYS_5M: z.coerce.number().int().nonnegative().default(10),
  EARLY_MOMENTUM_MIN_VOLUME_5M_USD: z.coerce.number().nonnegative().default(1000),
  // Allows at most one bounded follow-up momentum alert per token: fires again if
  // buys/volume (5m) have multiplied by at least this much since the original alert.
  MOMENTUM_REALERT_MULTIPLE: z.coerce.number().positive().default(3),
  ETH_USD_PRICE_REFRESH_SECONDS: z.coerce.number().int().positive().default(60),

  // Ascending multiples-since-first-alert (current market cap / entry baseline) that trigger
  // a "how many x's" performance milestone alert. Same guarded, never-re-fire ladder pattern
  // as MARKET_CAP_ALERT_TIERS_USD, keyed on peak_multiple instead of raw market cap.
  PERFORMANCE_MILESTONE_MULTIPLES: z.string().min(1).default("2,3,5,10,20,50,100,200,500,1000"),

  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().min(1).default("0.0.0.0"),

  DB_PATH: z.string().min(1).default("./data/pons-revival.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DRY_RUN_ALERTS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
