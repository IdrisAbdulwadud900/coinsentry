import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import pino from "pino";
import { loadConfig } from "./config.js";
import { openDatabase } from "./data/db.js";
import { TokenRepo } from "./data/tokenRepo.js";
import { WatchRepo } from "./data/watchRepo.js";
import { RuleRepo } from "./data/ruleRepo.js";
import { SnapshotRepo } from "./data/snapshotRepo.js";
import { SettingsRepo } from "./data/settingsRepo.js";
import { DigestRepo } from "./data/digestRepo.js";
import { DexScreenerClient } from "./data/dexscreener.js";
import { Poller } from "./engine/poller.js";
import { createNotifier } from "./bot/notifierAdapter.js";
import { setDeps } from "./bot/deps.js";
import { registerHandlers } from "./bot/handlers/index.js";
import type { BotContext } from "./bot/context.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, transport: { target: "pino-pretty" } });

  const db = openDatabase(config.DB_PATH);

  const tokenRepo = new TokenRepo(db);
  const watchRepo = new WatchRepo(db);
  const ruleRepo = new RuleRepo(db);
  const snapshotRepo = new SnapshotRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const digestRepo = new DigestRepo(db);
  const dex = new DexScreenerClient(logger.child({ module: "dexscreener" }));

  setDeps({ tokenRepo, watchRepo, ruleRepo, snapshotRepo, settingsRepo, digestRepo, dex, logger });

  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  bot.api.config.use(autoRetry());
  registerHandlers(bot);

  bot.catch((err) => {
    logger.error({ err: String(err.error), update: err.ctx.update.update_id }, "Unhandled bot error");
  });

  const notifier = createNotifier(bot.api);
  const poller = new Poller({
    tokenRepo,
    watchRepo,
    ruleRepo,
    snapshotRepo,
    settingsRepo,
    digestRepo,
    dex,
    notifier,
    logger: logger.child({ module: "poller" }),
    intervalSeconds: config.POLL_INTERVAL_SECONDS,
  });

  poller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    poller.stop();
    await bot.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Starting CoinSentry bot");
  await bot.start({
    onStart: (botInfo) => logger.info({ username: botInfo.username }, "Bot started"),
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
