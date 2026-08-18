import { Bot } from "grammy";
import pino from "pino";
import { loadConfig, csvAddresses } from "./config.js";
import { Store } from "./data/db.js";
import { RpcClient, readTokenIdentity, readBalanceOf } from "./data/rpc.js";
import { BlockscoutClient } from "./data/blockscout.js";
import { RpcLogSource } from "./data/logSource.js";
import { scanRange, type DiscoveredLaunch } from "./discovery.js";
import { formatLaunchAlert, type EnrichedLaunch } from "./alerts.js";
import { assessLaunchQuality, qualityBlockReason } from "./quality.js";
import { probeAccess, formatAccessAlert } from "./access.js";

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined,
});

const store = new Store(config.DB_PATH);
const rpcUrls = csvAddresses(config.ARC_RPC_URLS).map((u) => u.replace(/^https?:\/\//, "https://"));
const rpc = new RpcClient(rpcUrls, logger);
const blockscout = new BlockscoutClient(config.BLOCKSCOUT_BASE_URL, logger);
// Blockscout stays wired up regardless of the discovery source: it also serves
// contract-verification lookups and the explorer links in every alert.
const logSource =
  config.DISCOVERY_SOURCE === "rpc" ? new RpcLogSource(rpc, config.RPC_LOG_LIMIT) : blockscout;
const quoteTokens = new Set(csvAddresses(config.QUOTE_TOKENS));
// Filled at boot by readTokenIdentity so liquidity is scaled by each quote
// asset's real decimals (Arc USDC is 6, Robinhood WETH is 18) rather than an
// assumed constant, which would silently misreport every liquidity figure.
const quoteMeta = new Map<string, { symbol: string; decimals: number }>();
const v2Factories = csvAddresses(config.V2_FACTORIES);
const v3Factories = csvAddresses(config.V3_FACTORIES);
const bot = config.TELEGRAM_BOT_TOKEN ? new Bot(config.TELEGRAM_BOT_TOKEN) : null;

const CURSOR_SCOPE = "arc-factories";
// Blocks behind the tip to stop each scan at, so we never race Blockscout's
// indexer (its logs API lags head by a few seconds).
const HEAD_LAG_BLOCKS = 20n;

async function enrich(launch: DiscoveredLaunch): Promise<EnrichedLaunch> {
  const quote = quoteMeta.get(launch.quoteAddress);
  const [identity, liquidityRaw, deployer, verified] = await Promise.all([
    readTokenIdentity(rpc, launch.tokenAddress),
    quote
      ? readBalanceOf(rpc, launch.quoteAddress, launch.poolAddress).catch(() => null)
      : Promise.resolve(null),
    rpc.transactionFrom(launch.txHash).catch(() => null),
    blockscout.isContractVerified(launch.tokenAddress),
  ]);
  return {
    ...launch,
    symbol: identity.symbol,
    name: identity.name,
    liquidityQuote:
      liquidityRaw === null || !quote ? null : Number(liquidityRaw) / 10 ** quote.decimals,
    quoteSymbol: quote?.symbol ?? null,
    deployer,
    deployerLaunchCount: deployer ? store.countByDeployer(deployer) + 1 : 1,
    verified,
  };
}

function gate(launch: EnrichedLaunch): string | null {
  if (!quoteTokens.has(launch.quoteAddress)) return "quote-not-recognised";
  // Unknown liquidity (RPC failure) is gated, not given the benefit of the
  // doubt — an alert channel's credibility dies on unvetted entries.
  if (launch.liquidityQuote === null) return "liquidity-unknown";
  if (launch.liquidityQuote < config.MIN_LIQUIDITY_QUOTE) return "below-liquidity-floor";
  if (launch.deployer && launch.deployerLaunchCount > config.SPAM_DEPLOYER_THRESHOLD)
    return "spam-deployer";
  return null;
}

async function sendAlert(text: string): Promise<void> {
  if (config.DRY_RUN_ALERTS || !bot) {
    logger.info({ alert: text.replace(/<[^>]+>/g, "") }, "DRY RUN alert");
    return;
  }
  await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function discover(head: bigint): Promise<void> {
  const toBlock = head - HEAD_LAG_BLOCKS;
  const cursor = store.getCursor(CURSOR_SCOPE) ?? BigInt(config.DISCOVERY_START_BLOCK);
  if (cursor > toBlock) return;

  const launches = await scanRange({
    logSource,
    quoteTokens,
    v2Factories,
    v3Factories,
    fromBlock: cursor,
    toBlock,
    chunkBlocks: config.DISCOVERY_CHUNK_BLOCKS,
    logger,
  });

  let pending = 0;
  for (const launch of launches) {
    if (store.hasLaunch(launch.tokenAddress)) continue;

    // Pacing between tokens keeps enrichment under the public endpoints' burst
    // limits — hammering them cost ~30% of lookups in the first backfill test.
    await new Promise((r) => setTimeout(r, 150));
    const enriched = await enrich(launch);
    // Stale launches are recorded but never alerted. This is deliberately keyed
    // on distance from the chain head, not on whether this is the first scan of
    // the process: after a redeploy or a long access outage the first scan can
    // contain both a stale backlog and genuinely fresh launches, and only a
    // per-launch age test gets both of those right.
    const ageBlocks = toBlock - launch.blockNumber;
    const skipReason =
      gate(enriched) ?? (ageBlocks > BigInt(config.ALERT_RECENCY_BLOCKS) ? "stale" : null);

    store.insertLaunch({
      token_address: enriched.tokenAddress,
      symbol: enriched.symbol,
      name: enriched.name,
      kind: enriched.kind,
      factory: enriched.factory,
      pool_address: enriched.poolAddress,
      quote_address: enriched.quoteAddress,
      deployer: enriched.deployer,
      launch_block: enriched.blockNumber.toString(),
      tx_hash: enriched.txHash,
      liquidity_quote: enriched.liquidityQuote,
      quote_symbol: enriched.quoteSymbol,
      verified: enriched.verified === null ? null : enriched.verified ? 1 : 0,
      discovered_at: Date.now(),
      skip_reason: skipReason,
    });

    if (skipReason) {
      logger.debug({ token: enriched.tokenAddress, skipReason }, "Launch recorded, not alerted");
      continue;
    }
    // Survivors stay pending: their quality can't be judged until the
    // observation window after launch has actually elapsed on-chain.
    pending += 1;
  }

  // Cursor only advances after every launch in the range was durably inserted;
  // a throw above leaves it untouched so the next cycle rescans the same range
  // (safe: inserts are idempotent).
  store.setCursor(CURSOR_SCOPE, toBlock + 1n);

  if (launches.length > 0 || pending > 0) {
    logger.info({ scanned: `${cursor}-${toBlock}`, discovered: launches.length, pending }, "Discovery complete");
  }
}

/**
 * Second stage: judges launches whose observation window has now closed, then
 * either alerts or records why not. Kept separate from discovery because the
 * bundle and honeypot signals literally do not exist yet at discovery time —
 * the buys they measure happen in the blocks after the pool is created.
 */
async function processPending(head: bigint): Promise<number> {
  const ready = store.getPendingLaunches(head - BigInt(config.QUALITY_WINDOW_BLOCKS), 50);
  let alerted = 0;

  for (const row of ready) {
    const launchBlock = BigInt(row.launch_block);
    if (head - launchBlock > BigInt(config.ALERT_RECENCY_BLOCKS)) {
      store.markSkipped(row.token_address, "stale");
      continue;
    }

    const quality = await assessLaunchQuality(
      logSource,
      rpc,
      row.token_address,
      row.pool_address,
      launchBlock,
      config.QUALITY_WINDOW_BLOCKS,
      logger
    );
    const reason = qualityBlockReason(quality, {
      maxTop5Pct: config.BUNDLE_MAX_TOP5_PCT,
      honeypotMinBuyers: config.HONEYPOT_MIN_BUYERS,
    });

    if (reason) {
      store.markSkipped(row.token_address, reason);
      logger.debug({ token: row.token_address, reason }, "Blocked by quality gate");
      continue;
    }

    const deployerCount = row.deployer ? store.countByDeployer(row.deployer) : 1;
    await sendAlert(formatLaunchAlert(row, quality, deployerCount, blockscout));
    store.markAlerted(row.token_address);
    alerted += 1;
  }

  if (ready.length > 0) {
    logger.info({ assessed: ready.length, alerted }, "Quality pass complete");
  }
  return alerted;
}

/** One full pass: discover new launches, then judge the ones whose window closed. */
async function cycle(): Promise<void> {
  const head = await rpc.blockNumber();
  await discover(head);
  await processPending(head);
}

const ACCESS_FLAG = "access-state";

/**
 * Probes the endpoints and alerts only when the answer differs from the last
 * persisted state, so a bot restarted mid-outage stays quiet and a chain that
 * flaps doesn't produce a stream of duplicate notifications. Returns whether
 * access is currently open.
 */
async function checkAccess(): Promise<boolean> {
  const probe = await probeAccess(
    rpcUrls,
    config.BLOCKSCOUT_BASE_URL,
    config.DISCOVERY_SOURCE === "blockscout",
    logger
  );
  const current = probe.open ? "open" : "closed";
  const previous = store.getFlag(ACCESS_FLAG);

  if (previous === null) {
    logger.info({ state: current }, "Recorded initial access state");
  } else if (previous !== current) {
    logger.info({ from: previous, to: current }, "Arc access state changed");
    await sendAlert(formatAccessAlert(probe, probe.open));
  }

  store.setFlag(ACCESS_FLAG, current);
  return probe.open;
}

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/**
 * Reads each quote asset's symbol and decimals from its own contract. Runs
 * before any scanning, because without decimals every liquidity figure — and
 * therefore the alert floor — would be wrong by orders of magnitude.
 */
async function loadQuoteMeta(): Promise<void> {
  for (const address of quoteTokens) {
    const identity = await readTokenIdentity(rpc, address);
    if (identity.decimals === null) {
      throw new Error(`Could not read decimals for quote token ${address}; refusing to scan`);
    }
    quoteMeta.set(address, { symbol: identity.symbol ?? "?", decimals: identity.decimals });
    logger.info({ address, symbol: identity.symbol, decimals: identity.decimals }, "Quote asset resolved");
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  logger.info(
    {
      dryRun: config.DRY_RUN_ALERTS,
      v2Factories,
      v3Factories,
      startBlock: store.getCursor(CURSOR_SCOPE)?.toString() ?? config.DISCOVERY_START_BLOCK,
    },
    "arc-watch-bot starting"
  );

  if (once) {
    if (await checkAccess()) {
      await loadQuoteMeta();
      await cycle();
      logger.info("Single scan complete (--once), exiting");
    } else {
      logger.warn("Chain access is closed — nothing to scan (--once), exiting");
    }
    store.close();
    return;
  }

  // Boot-time failures must not kill a long-running worker: a chain's endpoints
  // can stay shut for weeks (as Arc's are), and the bot's whole job is to
  // already be running when access returns.
  let accessOpen = false;
  let quoteMetaLoaded = false;
  try {
    accessOpen = await checkAccess();
    if (accessOpen) {
      await loadQuoteMeta();
      quoteMetaLoaded = true;
    }
  } catch (err) {
    logger.error({ err: String(err) }, "Initial access probe failed, assuming closed");
  }

  // Serialized loop (not setInterval) so a slow cycle can never overlap the next.
  // While open it scans at the fast poll cadence with no probe overhead; a failed
  // cycle triggers a probe to find out whether access dropped, and while closed it
  // idles on the much slower probe interval.
  for (;;) {
    if (accessOpen) {
      try {
        await cycle();
        await sleep(config.POLL_INTERVAL_SECONDS);
        continue;
      } catch (err) {
        logger.error({ err: String(err) }, "Cycle failed, probing access");
      }
    } else {
      await sleep(config.ACCESS_PROBE_INTERVAL_SECONDS);
    }

    try {
      accessOpen = await checkAccess();
      // Deferred until access exists: on a chain that was shut at boot, this is
      // where the quote assets finally get resolved before the first scan.
      if (accessOpen && !quoteMetaLoaded) {
        await loadQuoteMeta();
        quoteMetaLoaded = true;
      }
    } catch (err) {
      accessOpen = false;
      logger.error({ err: String(err) }, "Access probe failed, will retry");
    }
    if (!accessOpen) await sleep(config.ACCESS_PROBE_INTERVAL_SECONDS);
  }
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "Fatal error");
  process.exit(1);
});
