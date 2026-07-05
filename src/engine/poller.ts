import type { Logger } from "pino";
import { DexScreenerClient, toMarketSnapshot } from "../data/dexscreener.js";
import type { DexPair } from "../types/dexscreener.js";
import { DigestRepo } from "../data/digestRepo.js";
import { RuleRepo } from "../data/ruleRepo.js";
import { SettingsRepo } from "../data/settingsRepo.js";
import { SnapshotRepo } from "../data/snapshotRepo.js";
import { TokenRepo } from "../data/tokenRepo.js";
import { WatchRepo } from "../data/watchRepo.js";
import type { TokenRow } from "../types/domain.js";
import { buildAlertText, buildNotIndexedAlert, type AlertText } from "./alertMessages.js";
import { evaluateRule } from "./ruleEvaluator.js";
import type { InlineButton, Notifier } from "./notifier.js";
import { escapeHtml } from "../util/html.js";

function groupByChain(tokens: TokenRow[]): Map<string, TokenRow[]> {
  const map = new Map<string, TokenRow[]>();
  for (const token of tokens) {
    const list = map.get(token.chain_id) ?? [];
    list.push(token);
    map.set(token.chain_id, list);
  }
  return map;
}

function renderAlert(alert: AlertText): string {
  return `<b>${escapeHtml(alert.title)}</b>\n${escapeHtml(alert.body)}`;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly deps: {
      tokenRepo: TokenRepo;
      watchRepo: WatchRepo;
      ruleRepo: RuleRepo;
      snapshotRepo: SnapshotRepo;
      settingsRepo: SettingsRepo;
      digestRepo: DigestRepo;
      dex: DexScreenerClient;
      notifier: Notifier;
      logger: Logger;
      intervalSeconds: number;
    }
  ) {}

  start(): void {
    const { intervalSeconds, logger } = this.deps;
    logger.info({ intervalSeconds }, "Starting poller");
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalSeconds * 1000);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.deps.logger.info("Poller stopped");
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      this.deps.logger.warn("Previous poll cycle still running, skipping this tick");
      return;
    }
    this.running = true;
    try {
      await this.pollAllTokens();
      await this.flushDueDigests();
    } catch (err) {
      this.deps.logger.error({ err: String(err) }, "Poll cycle failed unexpectedly");
    } finally {
      this.running = false;
    }
  }

  private async pollAllTokens(): Promise<void> {
    const { tokenRepo, dex, logger } = this.deps;
    const tokens = tokenRepo.listActivelyWatched();
    if (tokens.length === 0) return;

    const byChain = groupByChain(tokens);

    for (const [chainId, chainTokens] of byChain) {
      let pairs: DexPair[] = [];
      try {
        pairs = await dex.lookupBatch(
          chainId,
          chainTokens.map((t) => t.token_address)
        );
      } catch (err) {
        logger.error({ chainId, err: String(err) }, "Batch lookup failed for chain, skipping this chain this tick");
        continue;
      }

      for (const token of chainTokens) {
        try {
          await this.processToken(token, pairs);
        } catch (err) {
          logger.error({ tokenId: token.id, err: String(err) }, "Failed to process token, continuing");
        }
      }
    }
  }

  private async processToken(token: TokenRow, pairs: DexPair[]): Promise<void> {
    const { tokenRepo, watchRepo, ruleRepo, snapshotRepo } = this.deps;

    const match = pairs.find((p) => p.chainId === token.chain_id && p.pairAddress === token.pair_address);

    if (!match) {
      if (token.is_indexed) {
        tokenRepo.markIndexed(token.id, false);
        ruleRepo.pauseAllForToken(token.id);
        await this.broadcastToWatchers(token.id, buildNotIndexedAlert(token));
      }
      return;
    }

    if (!token.is_indexed) {
      tokenRepo.markIndexed(token.id, true);
    }

    const market = toMarketSnapshot(match, token.token_address);
    tokenRepo.upsertFromMarket(market);

    const history = snapshotRepo.recentForToken(token.id);
    const rules = ruleRepo.listActiveForToken(token.id);

    for (const rule of rules) {
      const config = ruleRepo.parseConfig(rule);
      const outcome = evaluateRule(config, rule.armed === 1, market, history, rule.last_fired_at, Date.now());
      ruleRepo.updateState(rule.id, outcome.newArmed, outcome.fired, outcome.shouldDeactivate);

      if (outcome.fired) {
        const watch = watchRepo.findById(rule.watch_id);
        if (!watch) continue;
        const alert = buildAlertText(config, market, watch, token);
        const buttons: InlineButton[] = [
          { text: "🔕 Disable rule", callbackData: `rule:disable:${rule.id}` },
          { text: "🔁 Re-arm", callbackData: `rule:rearm:${rule.id}` },
          { text: "📊 Token card", callbackData: `token:card:${token.id}` },
        ];
        await this.dispatch(rule.chat_id, alert, buttons);
      }
    }

    snapshotRepo.insert(token.id, market);
  }

  private async broadcastToWatchers(tokenId: number, alert: AlertText): Promise<void> {
    const watches = this.deps.watchRepo.listForToken(tokenId);
    for (const watch of watches) {
      await this.dispatch(watch.chat_id, alert);
    }
  }

  private async dispatch(chatId: number, alert: AlertText, buttons?: InlineButton[]): Promise<void> {
    const { settingsRepo, digestRepo, notifier, logger } = this.deps;
    const html = renderAlert(alert);

    if (settingsRepo.isQuietHoursNow(chatId)) {
      digestRepo.enqueue(chatId, html, buttons);
      return;
    }

    try {
      await notifier.sendAlert(chatId, html, buttons);
    } catch (err) {
      logger.error({ chatId, err: String(err) }, "Failed to send alert to chat");
    }
  }

  private async flushDueDigests(): Promise<void> {
    const { digestRepo, settingsRepo, notifier, logger } = this.deps;
    const chatIds = digestRepo.listChatsWithPending();

    for (const chatId of chatIds) {
      if (settingsRepo.isQuietHoursNow(chatId)) continue;

      const items = digestRepo.takeForChat(chatId);
      if (items.length === 0) continue;

      const combined = `<b>🔔 Alerts from your quiet hours (${items.length})</b>\n\n${items
        .map((i) => i.message_text)
        .join("\n\n")}`;

      try {
        await notifier.sendAlert(chatId, combined);
      } catch (err) {
        logger.error({ chatId, err: String(err) }, "Failed to send digest to chat");
      }
    }
  }
}
