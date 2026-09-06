import { Bot } from 'grammy';
import { config } from './config.js';
import { log } from './util/log.js';
import { registerHandlers } from './bot/handlers.js';
import { pollWatchlist } from './engine/watchPoller.js';
import { renderBuyAlert } from './bot/render/screens.js';

async function main(): Promise<void> {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Allowlist, when configured. Applied before any handler so a blocked chat
  // never triggers a provider request.
  if (config.allowedChatIds.length > 0) {
    bot.use(async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? '');
      if (!config.allowedChatIds.includes(chatId)) {
        log.warn({ chatId }, 'rejected chat');
        return;
      }
      await next();
    });
  }

  registerHandlers(bot);

  await bot.api.setMyCommands([
    { command: 'start', description: 'What this bot does' },
    { command: 'help', description: 'How to read the report' },
    { command: 'deep', description: 'Full replay: supply relays + dev cluster' },
    { command: 'watchlist', description: 'Wallets you are tracking' },
    { command: 'untrack', description: 'Stop tracking a wallet' },
  ]);

  const me = await bot.api.getMe();
  log.info(
    {
      bot: me.username,
      helius: config.hasHelius,
      solanaTracker: config.hasSolanaTracker,
      allowlist: config.allowedChatIds.length || 'open',
    },
    'starting XRAY',
  );

  if (!config.hasHelius && !config.hasSolanaTracker) {
    log.warn('No Solana provider key set — Solana tokens cannot be analyzed. EVM chains still work.');
  }

  // --- Watchlist polling ----------------------------------------------------
  // Runs alongside polling for updates. Each cycle is one cheap signature
  // listing per tracked wallet, bounded by the last signature already seen, so
  // an idle watchlist costs almost nothing.
  let watchTimer: NodeJS.Timeout | undefined;
  if (config.hasHelius && config.WATCH_POLL_SECONDS > 0) {
    let running = false;
    const cycle = async () => {
      // Skip rather than overlap: a slow cycle must not stack on the next one.
      if (running) return;
      running = true;
      try {
        for (const alert of await pollWatchlist()) {
          try {
            await bot.api.sendMessage(alert.chatId, renderBuyAlert(alert), {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
          } catch (err) {
            // A blocked chat or deleted conversation must not stop the loop.
            log.warn({ err, chatId: alert.chatId }, 'could not deliver watchlist alert');
          }
        }
      } catch (err) {
        log.error({ err }, 'watchlist poll failed');
      } finally {
        running = false;
      }
    };
    watchTimer = setInterval(() => void cycle(), config.WATCH_POLL_SECONDS * 1000);
    log.info({ everySeconds: config.WATCH_POLL_SECONDS }, 'watchlist polling enabled');
  }

  const stop = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    if (watchTimer) clearInterval(watchTimer);
    await bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  await bot.start({
    drop_pending_updates: true,
    onStart: () => log.info('polling for updates'),
  });
}

main().catch((err) => {
  log.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
