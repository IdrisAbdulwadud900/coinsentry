import { Bot } from "grammy";
import pino from "pino";
import { loadConfig } from "./config.js";
import { openDatabase } from "./data/db.js";
import { createChainClient } from "./data/chainClient.js";
import { DiscoveryStateRepo } from "./data/discoveryStateRepo.js";
import { TokenRepo } from "./data/tokenRepo.js";
import { SnapshotRepo } from "./data/snapshotRepo.js";
import { AlertRepo } from "./data/alertRepo.js";
import { SettingsRepo } from "./data/settingsRepo.js";
import { OutcomeRepo } from "./data/outcomeRepo.js";
import { DexScreenerClient } from "./data/dexscreener.js";
import { EthPriceClient } from "./data/ethPrice.js";
import { BlockscoutClient } from "./data/blockscoutClient.js";
import { SolanaClient } from "./data/solanaClient.js";
import { JupiterClient } from "./data/jupiterClient.js";
import { XSearchClient } from "./data/xSearchClient.js";
import { buildPoolChainConfigs } from "./data/dexPoolDiscovery.js";
import { Poller, runPollCycle, runFastCycle, type PollerDeps } from "./engine/poller.js";
import { buildClassifierConfig } from "./engine/classifier.js";
import type { FactoryConfig } from "./data/tokenDiscovery.js";
import { createNotifier } from "./bot/notifierAdapter.js";
import { setDeps } from "./bot/deps.js";
import { registerHandlers } from "./bot/handlers.js";
import { buildServer } from "./server/app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // pino-pretty is a dev convenience and, in production, a leak: it ships every log line to
  // a worker thread, and when that thread cannot keep up the undelivered lines pile up in
  // the main thread's heap. This bot logs per token across a very large table, which is
  // exactly the shape that outruns it — the process died on the heap limit every ~8 minutes
  // with ~470MB of live, unreclaimable objects, and the crash was indifferent to the market
  // scan batch size (8000 and 1500 both died), which ruled out the data path itself.
  // Writing plain JSON to stdout has no worker and no queue; Fly captures it the same way.
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDatabase(config.DB_PATH);
  const chainClient = createChainClient(config.ROBINHOOD_RPC_URL);
  const discoveryStateRepo = new DiscoveryStateRepo(db);
  const tokenRepo = new TokenRepo(db);
  const snapshotRepo = new SnapshotRepo(db);
  const alertRepo = new AlertRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const outcomeRepo = new OutcomeRepo(db);
  const dex = new DexScreenerClient(
    logger.child({ module: "dexscreener" }),
    config.DEXSCREENER_CONCURRENCY,
    config.DEXSCREENER_REQUESTS_PER_MINUTE
  );
  const ethPriceClient = new EthPriceClient(
    logger.child({ module: "eth-price" }),
    config.ETH_USD_PRICE_REFRESH_SECONDS * 1000
  );
  const blockscoutClient = new BlockscoutClient(logger.child({ module: "blockscout" }), config.BLOCKSCOUT_API_BASE_URL);
  // Holder data per chain: Robinhood + Ethereum have free keyless Blockscout instances.
  // BSC only joins if the owner supplies a Blockscout-compatible URL.
  const blockscoutByChain: Record<string, BlockscoutClient> = {
    robinhood: blockscoutClient,
    ethereum: new BlockscoutClient(logger.child({ module: "blockscout-eth" }), config.ETHEREUM_BLOCKSCOUT_URL),
  };
  if (config.BSC_BLOCKSCOUT_URL) {
    blockscoutByChain.bsc = new BlockscoutClient(logger.child({ module: "blockscout-bsc" }), config.BSC_BLOCKSCOUT_URL);
  }
  const solanaClient = new SolanaClient(logger.child({ module: "solana" }), config.SOLANA_RPC_URL);
  const jupiterClient = new JupiterClient(logger.child({ module: "jupiter" }));
  const xSearchClient = new XSearchClient(logger.child({ module: "x-search" }), config.X_BEARER_TOKEN);
  const marketCapAlertTiersUsd = config.MARKET_CAP_ALERT_TIERS_USD.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const performanceMilestoneMultiples = config.PERFORMANCE_MILESTONE_MULTIPLES.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  const enabledChains = config.ENABLED_CHAINS.split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);

  const factories: FactoryConfig[] = [
    { address: config.PONS_FACTORY_ACTIVE, startBlock: BigInt(config.PONS_FACTORY_ACTIVE_START_BLOCK) },
    { address: config.PONS_FACTORY_LEGACY, startBlock: BigInt(config.PONS_FACTORY_LEGACY_START_BLOCK) },
  ];
  // The launchpad currently minting. Both of the above are dormant (zero logs over 20,000
  // blocks); this one produces ~126 launches per 3,000 blocks and is where every missed
  // coin came from. Decoded by topic position — see ACTIVE_LAUNCHPAD_ADDRESS in config.
  if (config.ACTIVE_LAUNCHPAD_ADDRESS && config.ACTIVE_LAUNCHPAD_TOPIC0) {
    factories.push({
      address: config.ACTIVE_LAUNCHPAD_ADDRESS,
      startBlock: BigInt(config.ACTIVE_LAUNCHPAD_START_BLOCK),
      launchTopic0: config.ACTIVE_LAUNCHPAD_TOPIC0,
      tokenTopicIndex: 1,
      poolTopicIndex: 2,
      deployerTopicIndex: 3,
    });
  }

  const classifierConfig = buildClassifierConfig(
    {
      deadMinAgeHours: config.DEAD_MIN_AGE_HOURS,
      deadVolume24hUsd: config.DEAD_VOLUME_24H_USD,
      deadMinBuys1h: config.DEAD_MIN_BUYS_1H,
      deadConfirmPolls: config.DEAD_CONFIRM_POLLS,
      revivalVolumeMultiple: config.REVIVAL_VOLUME_MULTIPLE,
      revivalMinVolume1hUsd: config.REVIVAL_MIN_VOLUME_1H_USD,
      revivalMinBuys1h: config.REVIVAL_MIN_BUYS_1H,
      revivalLiquidityFloorPct: config.REVIVAL_LIQUIDITY_FLOOR_PCT,
      revivalConfirmPolls: config.REVIVAL_CONFIRM_POLLS,
      demoteConfirmPolls: config.DEMOTE_CONFIRM_POLLS,
      alertCooldownHours: config.ALERT_COOLDOWN_HOURS,
    },
    settingsRepo
  );

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  registerHandlers(bot);

  bot.catch((err) => {
    logger.error({ err: String(err.error), update: err.ctx.update.update_id }, "Unhandled bot error");
  });

  const notifier = createNotifier(bot.api, logger.child({ module: "notifier" }));

  const pollerDeps: PollerDeps = {
    chainClient,
    discoveryStateRepo,
    tokenRepo,
    snapshotRepo,
    alertRepo,
    dex,
    notifier,
    logger: logger.child({ module: "poller" }),
    classifierConfig,
    factories,
    dexScreenerChainId: config.ROBINHOOD_CHAIN_ID_DEXSCREENER,
    discoveryChunkBlocks: config.DISCOVERY_CHUNK_BLOCKS,
    discoveryMaxLaunchesPerCycle: config.DISCOVERY_MAX_LAUNCHES_PER_CYCLE,
    discoveryColdStartLookbackBlocks: config.DISCOVERY_COLD_START_LOOKBACK_BLOCKS,
    discoveryMinLiquidityUsd: config.DISCOVERY_MIN_LIQUIDITY_USD,
    spamDeployerThreshold: config.SPAM_DEPLOYER_THRESHOLD,
    unindexedRecheckHours: config.UNINDEXED_RECHECK_HOURS,
    graduationCheckBatchSize: config.GRADUATION_CHECK_BATCH_SIZE,
    snapshotRetentionDays: config.SNAPSHOT_RETENTION_DAYS,
    unindexedSweepBatchSize: config.UNINDEXED_SWEEP_BATCH_SIZE,
    telegramChatId: config.TELEGRAM_CHAT_ID,
    dryRunAlerts: config.DRY_RUN_ALERTS,
    ethPriceClient,
    ungraduatedFastWindowHours: config.UNGRADUATED_FAST_WINDOW_HOURS,
    marketCapAlertTiersUsd,
    earlyMomentumMaxAgeMinutes: config.EARLY_MOMENTUM_MAX_AGE_MINUTES,
    earlyMomentumMinBuys5m: config.EARLY_MOMENTUM_MIN_BUYS_5M,
    earlyMomentumMinVolume5mUsd: config.EARLY_MOMENTUM_MIN_VOLUME_5M_USD,
    momentumRealertMultiple: config.MOMENTUM_REALERT_MULTIPLE,
    performanceMilestoneMultiples,
    earlyBuyWindowBlocks: config.EARLY_BUY_WINDOW_BLOCKS,
    outcomeRepo,
    settingsRepo,
    marketScanBatchSize: config.MARKET_SCAN_BATCH_SIZE,
    noMarketDataDemoteStreak: config.NO_MARKET_DATA_DEMOTE_STREAK,
    minLiquidityToMcapPct: config.MIN_LIQUIDITY_TO_MCAP_PCT,
    enabledChains,
    dexPoolDiscoveryEnabled: config.DEX_POOL_DISCOVERY_ENABLED,
    ponsLaunchpadOnly: config.PONS_LAUNCHPAD_ONLY,
    ponsFactoryFilter: config.PONS_FACTORY_FILTER || null,
    robinhoodRpcUrl: config.ROBINHOOD_RPC_URL,
    swapScanMaxChunksPerCycle: config.SWAP_SCAN_MAX_CHUNKS_PER_CYCLE,
    eventDrivenWindowHours: config.EVENT_DRIVEN_WINDOW_HOURS,
    resolvedPoolCache: new Set<string>(),
    poolChainConfigs: buildPoolChainConfigs({
      robinhood: config.ROBINHOOD_RPC_URL,
      bsc: config.BSC_RPC_URL || undefined,
      ethereum: config.ETHEREUM_RPC_URL || undefined,
      hyperevm: config.HYPEREVM_RPC_URL || undefined,
    }),
    blockscoutByChain,
    solanaClient,
    jupiterClient,
    xSearchClient,
    solanaSpamDevMints: config.SOLANA_SPAM_DEV_MINTS,
    minAlertConviction: config.MIN_ALERT_CONVICTION,
    breakoutVolumeMultiple: config.BREAKOUT_VOLUME_MULTIPLE,
    breakoutMinVolume1hUsd: config.BREAKOUT_MIN_VOLUME_1H_USD,
    breakoutMinBuys1h: config.BREAKOUT_MIN_BUYS_1H,
    breakoutCooldownHours: config.BREAKOUT_COOLDOWN_HOURS,
    reversalMultiple: config.REVERSAL_MULTIPLE,
  };

  const poller = new Poller({
    run: () => runPollCycle(pollerDeps),
    intervalSeconds: config.POLL_INTERVAL_SECONDS,
    label: "slow",
    logger: logger.child({ module: "poller" }),
  });

  const fastPoller = new Poller({
    run: () => runFastCycle(pollerDeps),
    intervalSeconds: config.FAST_DISCOVERY_INTERVAL_SECONDS,
    label: "fast",
    logger: logger.child({ module: "fast-poller" }),
  });

  setDeps({ tokenRepo, poller, logger, settingsRepo, outcomeRepo, classifierConfig, telegramChatId: config.TELEGRAM_CHAT_ID });

  const server = buildServer({
    tokenRepo,
    snapshotRepo,
    alertRepo,
    poller,
    logger: logger.child({ module: "server" }),
    botToken: config.TELEGRAM_BOT_TOKEN,
    allowedUserId: config.TELEGRAM_CHAT_ID,
    classifierConfig,
  });

  if (config.POLLING_ENABLED) {
    poller.start();
    if (config.FAST_POLLING_ENABLED) fastPoller.start();
    else logger.warn("FAST_POLLING_ENABLED is false — new-launch fast lane is off by design");
  } else {
    logger.warn("POLLING_ENABLED is false — running in maintenance mode, no discovery or alerts");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    poller.stop();
    fastPoller.stop();
    await server.close();
    await bot.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, "API server listening");

  // Register the command list so typing "/" in Telegram autocompletes them, and clear the
  // chat menu button back to that list. The button is stored on Telegram's servers, so it
  // kept showing "Open App" long after the mini app itself was deleted from this codebase —
  // removing the code was never going to be enough on its own.
  try {
    await bot.api.setMyCommands([
      { command: "status", description: "Tracking status and per-chain counts" },
      { command: "insights", description: "Win rates and what the observer has learned" },
      { command: "performance", description: "Top performers since alert" },
      { command: "dead", description: "Browse dead tokens" },
      { command: "focus", description: "Focus scanning on one chain (owner only)" },
      { command: "config", description: "Show classifier thresholds" },
      { command: "setconfig", description: "Change a threshold (owner only)" },
      { command: "resetconfig", description: "Restore a threshold's default (owner only)" },
    ]);
    await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
    logger.info("Registered command menu and cleared the chat menu button");
  } catch (err) {
    logger.warn({ err: String(err) }, "Could not set up the Telegram command menu, continuing");
  }

  logger.info({ dryRunAlerts: config.DRY_RUN_ALERTS }, "Starting Pons Revival Signal Bot");
  await bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Bot started");
    },
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
