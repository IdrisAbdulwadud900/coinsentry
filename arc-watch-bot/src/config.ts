import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z
  .object({
    // Optional so DRY_RUN sessions can run discovery against the live chain
    // without a bot token; enforced below when DRY_RUN_ALERTS is false.
    TELEGRAM_BOT_TOKEN: z.string().default(""),
    TELEGRAM_CHAT_ID: z.string().default(""),

    // Blockdaemon is Arc's public un-gated endpoint; Blockscout's eth-rpc is the
    // fallback. thirdweb's 5042 endpoint is deliberately excluded — it rejects
    // getLogs and intermittently 500s on eth_call.
    ARC_RPC_URLS: z
      .string()
      .min(1)
      .default(
        "https://rpc.blockdaemon.mainnet.arc.io,https://arc-mainnet.cloud.blockscout.com/api/eth-rpc"
      ),
    BLOCKSCOUT_BASE_URL: z.string().url().default("https://arc-mainnet.cloud.blockscout.com"),

    // Where discovery reads factory events. "rpc" (eth_getLogs) is right for any
    // chain whose node allows it; "blockscout" exists because Arc's public RPC
    // rejects eth_getLogs outright. Blockscout's free tier also rate-limits well
    // below what a high-volume chain needs, so prefer "rpc" wherever it works.
    DISCOVERY_SOURCE: z.enum(["rpc", "blockscout"]).default("blockscout"),
    // Response cap for the rpc source; a chunk returning this many logs is
    // re-scanned in smaller pieces in case the node truncated it.
    RPC_LOG_LIMIT: z.coerce.number().int().positive().default(10_000),

    // Quote assets a pool must be paired against to be alertable, as a CSV. The
    // token side is whichever side of the pair isn't one of these. Chain-specific:
    // Arc quotes in native USDC, Robinhood Chain quotes in WETH (289 of 296
    // sampled pools) with a little USDG. Decimals are read on-chain at boot
    // rather than configured, since a wrong decimals value silently scales every
    // liquidity figure and would corrupt the alert floor.
    QUOTE_TOKENS: z.string().min(1).default("0x3600000000000000000000000000000000000000"),

    // Discovered live on 2026-07-30 by scanning the whole chain for factory events:
    //  - 0xdfef… : launchpad-style factory (PairCreated where pair == token: the token
    //    contract is its own bonding-curve pool). Highest launch rate.
    //  - 0x942b… : classic UniswapV2-style AMM factory (distinct pair contract).
    //  - 0xf0db… : verified UniswapV3Factory.
    V2_FACTORIES: z
      .string()
      .min(1)
      .default("0xdfef2f90f7e52609cc89b80b68ff6a1c86c4ddc4,0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10"),
    V3_FACTORIES: z.string().min(1).default("0xf0db7b58379503491d857db50ac9ece64c653918"),

    // First block to scan when the DB has no cursor yet. Defaults to shortly before
    // the earliest observed factory event (block 12,664,133) so a fresh DB backfills
    // the entire launch history rather than starting mid-stream.
    DISCOVERY_START_BLOCK: z.coerce.number().int().nonnegative().default(12_600_000),
    // Blockscout's logs API caps a response at 1000 records; chunking the block range
    // keeps every window under that cap so no launch can be silently truncated away.
    DISCOVERY_CHUNK_BLOCKS: z.coerce.number().int().positive().default(100_000),

    POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
    // While access is closed the bot idles on this much slower cadence: a gated
    // host may stay shut for weeks, and probing it every 15s would be both
    // pointless and abusive. Only the cheap probe runs at this interval.
    ACCESS_PROBE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

    // Only launches this recent relative to the chain head are alertable; older
    // ones are recorded silently. Judging recency by block age rather than by
    // "is this the process's first scan" is what keeps a restart, a redeploy, or
    // a multi-week access outage from either spamming a stale backlog or
    // swallowing the fresh launches that arrived during the gap.
    // ~7200 blocks ≈ 1 hour at Arc's observed 505ms block time.
    ALERT_RECENCY_BLOCKS: z.coerce.number().int().positive().default(7200),

    // Blocks after launch to observe before judging a token's quality. Alerting
    // waits for this window to elapse, trading a short delay for a real read on
    // who bought and whether anyone could sell. 500 blocks is ~50s on Robinhood
    // Chain (101ms) and ~4min on Arc (505ms).
    QUALITY_WINDOW_BLOCKS: z.coerce.number().int().positive().default(500),
    // Never alert on a token whose top-5 early buyers hold more than this share
    // of supply. 60 matches the hard rule already used by pons-revival-bot.
    BUNDLE_MAX_TOP5_PCT: z.coerce.number().min(0).max(100).default(60),
    // Buyers required before "zero sells" counts as honeypot evidence rather
    // than just a quiet token.
    HONEYPOT_MIN_BUYERS: z.coerce.number().int().positive().default(15),

    // Alert gates (same philosophy as CoinSentry/pons: never alert on what you
    // wouldn't want a subscriber to click).
    // Minimum pool liquidity, denominated in whole units of the quote asset it
    // was paired against (so 1000 means 1000 USDC on Arc, but would mean 1000
    // WETH on a WETH-quoted chain — retune per chain, it is not a USD figure).
    // The Arc sample on 2026-07-30 showed ~470 launches clearing a 200-USDC
    // floor, an unusable alert rate; 1000 cut it to a handful per hour.
    MIN_LIQUIDITY_QUOTE: z.coerce.number().nonnegative().default(1000),
    SPAM_DEPLOYER_THRESHOLD: z.coerce.number().int().positive().default(10),

    DB_PATH: z.string().min(1).default("./data/arc-watch.db"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    DRY_RUN_ALERTS: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.DRY_RUN_ALERTS && (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when DRY_RUN_ALERTS=false",
      });
    }
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

export function csvAddresses(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
