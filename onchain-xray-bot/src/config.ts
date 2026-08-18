import 'dotenv/config';
import { z } from 'zod';

const num = (def: number) =>
  z.coerce.number().refine((n) => Number.isFinite(n), 'must be a number').default(def);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'TELEGRAM_BOT_TOKEN is required'),
  /** Comma-separated chat IDs allowed to use the bot. Empty = open to everyone. */
  ALLOWED_CHAT_IDS: z.string().default(''),

  // --- Solana data providers -------------------------------------------------
  /** https://dashboard.helius.dev — free tier is enough for most tokens. */
  HELIUS_API_KEY: z.string().default(''),
  /** https://www.solanatracker.io/data-api — free tier: 10k req/mo. */
  SOLANATRACKER_API_KEY: z.string().default(''),
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),

  // --- EVM RPCs --------------------------------------------------------------
  // Empty means "use the built-in fallback list in data/chains.ts". Set one of
  // these to a keyed archive endpoint (Alchemy/Infura/QuickNode) for full
  // coverage of older tokens — BSC in particular has no keyless archive RPC.
  ETHEREUM_RPC_URL: z.string().default(''),
  BSC_RPC_URL: z.string().default(''),
  BASE_RPC_URL: z.string().default(''),
  /** Override the per-chain eth_getLogs span. 0 = use the chain's own default. */
  EVM_LOG_CHUNK_BLOCKS: num(0),
  /** Cap on how many chunks we walk before giving up on full history. */
  EVM_MAX_LOG_CHUNKS: num(400),
  /**
   * Wall-clock ceiling for one EVM log replay.
   *
   * Public RPCs cap a getLogs range at 10,000 blocks, and a two-year-old Base
   * token spans ~39 million — thousands of sequential requests. Without a
   * deadline the scan simply runs until the user gives up, which is worse than
   * returning a smaller window and saying so.
   */
  EVM_SCAN_BUDGET_MS: num(90_000),
  /**
   * Concurrent eth_getLogs requests.
   *
   * Measured against mainnet.base.org 2026-08-17: 10 concurrent completed
   * 20/20 at 7.9 req/s, while 20 completed only 15/40 and 40 only 29/80. Going
   * faster does not fetch more data, it just loses it — and a dropped chunk is
   * invisible in the output, which is the failure mode this bot has had to fix
   * three times already.
   */
  EVM_LOG_CONCURRENCY: num(10),
  /**
   * Share of the log budget spent on the launch window, the rest on recent
   * blocks. Walking forward from launch alone never reaches the present, so a
   * two-year-old token reported its first weeks and nothing since.
   */
  EVM_LAUNCH_WINDOW_SHARE: num(0.6),

  // --- Analysis thresholds ---------------------------------------------------
  /** Absolute "got in early" market cap ceiling. */
  EARLY_MCAP_USD: num(10_000),
  /** Floor band = [floorMcap, floorMcap * FLOOR_BAND_MULT]. */
  FLOOR_BAND_MULT: num(1.75),
  /** Multiples a wallet must have ridden before selling to count as a diamond hand. */
  DIAMOND_BUCKETS: z.string().default('3,4,5,10,25,50,100'),
  /**
   * Absolute sanity floor for a position, in USD. Scaling alone would let a
   * micro-cap launch surface cent-sized test buys.
   */
  MIN_POSITION_USD: num(5),
  /**
   * The real threshold: a position must be worth at least this percentage of
   * the coin's floor market cap to appear in any leaderboard.
   */
  MIN_POSITION_FLOOR_PCT: num(0.05),
  /** Treat a position as fully exited at this sold/held ratio. */
  FULL_EXIT_RATIO: num(0.95),
  /**
   * Ignore swaps below this USD value.
   *
   * Solana charges ~0.00204 SOL of rent to open an associated token account.
   * When a transaction's swap event cannot be decoded, that rent is
   * indistinguishable from payment in the fee payer's balance delta, and a
   * ~$0.16 "purchase" of a handful of tokens implies a market cap hundreds of
   * times the real one. Economically meaningless trades cannot set the price.
   */
  MIN_TRADE_USD: num(1),
  /**
   * A wallet must hold at least this long before its run counts as conviction.
   * Without it, a same-block flipper inherits whatever spike happened around it.
   */
  DIAMOND_MIN_HOLD_SECONDS: num(60),

  // --- Price-outlier rejection ----------------------------------------------
  /** Trades compared against the median of this many time-neighbours. */
  OUTLIER_WINDOW: num(25),
  /** Skip outlier rejection entirely below this many trades. */
  OUTLIER_MIN_SAMPLES: num(20),
  /** Max deviation from the local median for a normal-sized trade. */
  OUTLIER_DEVIATION: num(10),
  /** Trades under this USD value are held to a tighter tolerance. */
  OUTLIER_SMALL_TRADE_USD: num(5),
  /** Max deviation for those small trades — they cannot have moved the market. */
  OUTLIER_SMALL_DEVIATION: num(3),

  // --- Supply relay detection ------------------------------------------------
  /** Sink must sell at least this share of what it received to count as a relay. */
  RELAY_MIN_SINK_SELL_RATIO: num(0.5),
  /** Ignore dust relays below this share of total supply. */
  RELAY_MIN_SUPPLY_PCT: num(0.05),
  /** Sink selling within this many seconds of receiving looks deliberate. */
  RELAY_FAST_SELL_SECONDS: num(3 * 3600),

  // --- Dev graph -------------------------------------------------------------
  /** How many hops out from the dev wallet to walk the funding graph. */
  DEV_GRAPH_HOPS: num(2),
  /** Max wallets to expand per hop, keeps free-tier credits sane. */
  DEV_GRAPH_FANOUT: num(25),
  /** Buys in the first N seconds after launch count as bundle co-buys. */
  BUNDLE_WINDOW_SECONDS: num(30),

  // --- Budget / performance --------------------------------------------------
  /**
   * Hard ceiling on transactions HYDRATED for one token. This is the expensive
   * budget — one request per 100 transactions, each returning full bodies.
   */
  MAX_TX_FETCH: num(25_000),
  /**
   * How far back to LIST signatures, which is cheap: 1000 per request with no
   * transaction bodies.
   *
   * This must be budgeted separately from hydration. Signatures are returned
   * newest-first, so a shared budget stops the walk partway and leaves the
   * oldest signature in hand somewhere in the middle of the token's life — and
   * everything downstream then treats that point as the launch, reporting a
   * "floor" that is merely the low of a recent window.
   */
  MAX_SIGNATURE_SCAN: num(120_000),
  /** Parallel in-flight provider requests. */
  FETCH_CONCURRENCY: num(4),
  /**
   * Helius is paced separately and much more conservatively. Measured against
   * the free tier 2026-08-12: 4 concurrent with a 120ms gap survived only 24.9%
   * of hydration batches, and the losses were silent — the analysis ran on a
   * quarter of the history while presenting it as complete.
   */
  HELIUS_CONCURRENCY: num(2),
  HELIUS_MIN_INTERVAL_MS: num(350),
  /** 429s are routine on the free tier and recoverable; give up late. */
  HELIUS_MAX_RETRIES: num(7),
  /**
   * How many of the strongest wallets to rate against their lifetime record.
   * Each costs one provider request, so this trades scan time for the signal
   * that separates a repeat winner from a one-time lucky entry.
   */
  SMART_MONEY_LOOKUPS: num(8),

  // --- Proven winners --------------------------------------------------------
  /** Minimum profit on a coin for it to count as a win. */
  WINNER_MIN_PROFIT_USD: num(300),
  /** Minimum return multiple. $300 on $30,000 is not the same skill as on $100. */
  WINNER_MIN_MULTIPLE: num(3),
  /** Minimum stake, so a lucky $3 snipe cannot outrank real size. */
  WINNER_MIN_INVESTED_USD: num(50),
  /** Other coins a wallet must have won the same way to qualify. */
  WINNER_MIN_REPEAT_COINS: num(3),
  /**
   * Leaderboard entries checked against their full history. Each is one large
   * request, so this bounds both scan time and the free-tier budget.
   */
  WINNER_LOOKUPS: num(12),
  /** Per-wallet ceiling for the heavy history call. Not retried on timeout. */
  WINNER_LOOKUP_TIMEOUT_MS: num(12_000),
  /** Wall-clock ceiling for the whole track-record phase. */
  WINNER_PHASE_BUDGET_MS: num(45_000),

  // --- Winning play -----------------------------------------------------------
  /** Entered within this long of launch: a snipe. */
  PLAY_SNIPE_SECONDS: num(300),
  /** Entered within this long of launch: still early. */
  PLAY_EARLY_SECONDS: num(3600),
  /** Held for less than this before selling: a flip. */
  PLAY_FLIP_SECONDS: num(1800),
  /** Buys and sells that mark a position being scaled rather than shot. */
  PLAY_SCALE_MIN_BUYS: num(3),
  PLAY_SCALE_MIN_SELLS: num(3),
  /** Wallets below this profit do not shape the answer to "what worked". */
  PLAY_MIN_PROFIT_USD: num(300),

  // --- Side wallets ----------------------------------------------------------
  /** Top winners whose funding peers are checked. Each is one bounded lookup. */
  SIDE_WALLET_LOOKUPS: num(10),
  /** Wall-clock ceiling for the side-wallet phase, separate from the one above. */
  SIDE_WALLET_BUDGET_MS: num(25_000),
  /** Wallet histories read in parallel. Independent lookups, so this is free. */
  SIDE_WALLET_CONCURRENCY: num(4),
  /** Transactions read per winner when looking for funding links. */
  SIDE_WALLET_TX_BUDGET: num(300),
  /** Minimum SOL in a single transfer before it counts as funding at all. */
  SIDE_WALLET_MIN_SOL: num(0.05),
  /** A shared funder must have sent at least this much to BOTH wallets. */
  SIDE_WALLET_SHARED_MIN_SOL: num(0.4),
  /** One shared funder suffices when it sent at least this much to both. */
  SIDE_WALLET_STRONG_SOL: num(25),
  /** Shared funders needed to call two wallets linked, at ordinary amounts. */
  SIDE_WALLET_MIN_SHARED_FUNDERS: num(2),
  /**
   * How unequal two amounts from one shared funder may be. Operators send their
   * own wallets matching sums; services bill each on its own usage.
   */
  SIDE_WALLET_MIRROR_RATIO: num(1.5),
  /**
   * Wallets busier than this are not worth a lookup: their newest transactions
   * cover hours, so the funding is out of reach. A budget rule, not a
   * correctness one — the mirror test is what rejects bad links.
   */
  SIDE_WALLET_MAX_COINS: num(800),
  /** A side wallet must itself have profited by at least this much. */
  SIDE_WALLET_MIN_PROFIT_USD: num(100),
  /**
   * Replay every transaction by default, or answer from precomputed data.
   *
   * The transaction replay is the slowest part of the bot by an order of
   * magnitude — minutes against seconds — and it contributes nothing to the
   * questions most people ask: who made money here, and are they any good. Both
   * are answered by a leaderboard call and one lookup per candidate.
   *
   * The replay is still what powers supply relays and the dev funding graph, so
   * it stays available on demand rather than being removed.
   */
  DEEP_SCAN_BY_DEFAULT: z.coerce.boolean().default(false),
  // --- Wallet watchlist ------------------------------------------------------
  /** Where the tracked-wallet list is persisted. */
  WATCHLIST_PATH: z.string().default('./data/watchlist.json'),
  /** Per-chat cap, so one user cannot exhaust the polling budget. */
  MAX_WATCHED_WALLETS: num(25),
  /**
   * Seconds between checks. Each check is one cheap signature listing per
   * wallet, asking only for activity newer than the last one seen.
   */
  WATCH_POLL_SECONDS: num(120),
  /** Alerts suppressed below this SOL size, to keep dust out of the feed. */
  WATCH_MIN_SOL: num(0.05),
  /** Cap on new signatures read per wallet per check, for a very busy wallet. */
  WATCH_MAX_NEW_SIGNATURES: num(200),
  /** Rolling log of watched-wallet buys, used to spot convergence. */
  BUYLOG_PATH: z.string().default('./data/recent-buys.json'),
  /**
   * How long two buys can be apart and still count as the same move. Good
   * traders buy many things; several of them buying the SAME thing within a
   * few hours is the signal worth waking someone for.
   */
  CONVERGENCE_WINDOW_HOURS: num(6),
  /** Distinct tracked wallets required before a convergence alert fires. */
  CONVERGENCE_MIN_WALLETS: num(2),
  /**
   * Minutes before the same wallet buying the same token can alert again.
   * Averaging into a position is one decision spread over many transactions.
   */
  ALERT_COOLDOWN_MINUTES: num(60),
  /** Cache a completed analysis for this long. */
  CACHE_TTL_SECONDS: num(15 * 60),
  /** Per-user cooldown between analyses. */
  USER_COOLDOWN_SECONDS: num(10),

  // --- Presentation ----------------------------------------------------------
  LEADERBOARD_PAGE_SIZE: num(8),

  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

export const config = {
  ...raw,
  allowedChatIds: raw.ALLOWED_CHAT_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  diamondBuckets: raw.DIAMOND_BUCKETS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 1)
    .sort((a, b) => a - b),
  hasHelius: raw.HELIUS_API_KEY.length > 0,
  hasSolanaTracker: raw.SOLANATRACKER_API_KEY.length > 0,
};

export type Config = typeof config;
