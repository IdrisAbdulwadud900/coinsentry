import type { Bot } from "grammy";
import { createConversation, conversations } from "@grammyjs/conversations";
import type { BotContext } from "../context.js";
import { getDeps } from "../deps.js";
import { extractAddress } from "../addressDetect.js";
import { handleAddressInput } from "./addressInput.js";
import { addCoinConversation } from "../conversations/addCoin.js";
import { thresholdRuleConversation } from "../conversations/thresholdRule.js";
import { trendRuleConversation } from "../conversations/trendRule.js";
import { percentMoveRuleConversation } from "../conversations/percentMoveRule.js";
import { quietHoursConversation, timezoneConversation } from "../conversations/settings.js";
import { cb, parseIdSuffix } from "../callbackData.js";
import { mainMenu, showMainMenu } from "../menus/main.js";
import { showHelp, showRulesList, showSettings, showTokenCard, showWatchlistPage } from "../screens.js";
import { backToMenuKeyboard } from "../cards.js";

export function registerHandlers(bot: Bot<BotContext>): void {
  bot.use(conversations());
  bot.use(createConversation(addCoinConversation, "addCoin"));
  bot.use(createConversation(thresholdRuleConversation, "thresholdRule"));
  bot.use(createConversation(trendRuleConversation, "trendRule"));
  bot.use(createConversation(percentMoveRuleConversation, "percentMoveRule"));
  bot.use(createConversation(quietHoursConversation, "quietHours"));
  bot.use(createConversation(timezoneConversation, "timezone"));
  bot.use(mainMenu);

  bot.command("start", showMainMenu);
  bot.command("help", showHelp);
  bot.command("settings", showSettings);
  bot.command("watchlist", (ctx) => showWatchlistPage(ctx, 0));

  bot.callbackQuery(cb.mainMenu(), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
  });
  bot.callbackQuery(cb.help(), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
  });
  bot.callbackQuery(cb.settingsOpen(), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSettings(ctx);
  });
  bot.callbackQuery(cb.settingsQuietHours(), (ctx) => ctx.conversation.enter("quietHours"));
  bot.callbackQuery(cb.settingsTimezone(), (ctx) => ctx.conversation.enter("timezone"));

  bot.callbackQuery(cb.addCoin(), (ctx) => ctx.conversation.enter("addCoin"));
  bot.callbackQuery(cb.tokenCancel(), async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.", { reply_markup: backToMenuKeyboard() });
  });

  bot.callbackQuery(/^watchlist:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showWatchlistPage(ctx, Number(ctx.match![1]));
  });

  bot.callbackQuery(/^token:card:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTokenCard(ctx, Number(ctx.match![1]));
  });

  bot.callbackQuery(/^token:rule:(mcap|price|liq):(\d+)$/, (ctx) => ctx.conversation.enter("thresholdRule"));
  bot.callbackQuery(/^token:rule:trend:(\d+)$/, (ctx) => ctx.conversation.enter("trendRule"));
  bot.callbackQuery(/^token:rule:pct:(\d+)$/, (ctx) => ctx.conversation.enter("percentMoveRule"));

  bot.callbackQuery(/^watch:rules:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRulesList(ctx, Number(ctx.match![1]));
  });

  bot.callbackQuery(/^watch:remove:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const watchId = Number(ctx.match![1]);
    const { watchRepo } = getDeps();
    const watch = watchRepo.findById(watchId);
    if (!watch || watch.chat_id !== ctx.chat?.id) return;
    watchRepo.remove(watchId);
    await ctx.editMessageText("🗑 Removed from your watchlist.", { reply_markup: backToMenuKeyboard() });
  });

  bot.callbackQuery(/^rule:pause:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ruleId = Number(ctx.match![1]);
    const { ruleRepo } = getDeps();
    const rule = ruleRepo.findById(ruleId);
    if (!rule || rule.chat_id !== ctx.chat?.id) return;
    ruleRepo.setPaused(ruleId, true);
    await showRulesList(ctx, rule.watch_id);
  });

  bot.callbackQuery(/^rule:resume:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ruleId = Number(ctx.match![1]);
    const { ruleRepo } = getDeps();
    const rule = ruleRepo.findById(ruleId);
    if (!rule || rule.chat_id !== ctx.chat?.id) return;
    ruleRepo.setPaused(ruleId, false);
    await showRulesList(ctx, rule.watch_id);
  });

  bot.callbackQuery(/^rule:delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ruleId = Number(ctx.match![1]);
    const { ruleRepo } = getDeps();
    const rule = ruleRepo.findById(ruleId);
    if (!rule || rule.chat_id !== ctx.chat?.id) return;
    ruleRepo.delete(ruleId);
    await showRulesList(ctx, rule.watch_id);
  });

  // Buttons on live alert notifications sent directly by the poller (separate messages).
  bot.callbackQuery(/^rule:disable:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Rule disabled");
    const ruleId = parseIdSuffix(ctx.callbackQuery.data);
    if (ruleId === null) return;
    getDeps().ruleRepo.setPaused(ruleId, true);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  });

  bot.callbackQuery(/^rule:rearm:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Rule re-armed");
    const ruleId = parseIdSuffix(ctx.callbackQuery.data);
    if (ruleId === null) return;
    const { ruleRepo } = getDeps();
    const rule = ruleRepo.findById(ruleId);
    if (rule) {
      ruleRepo.setPaused(ruleId, false);
      ruleRepo.updateState(ruleId, true, false, false);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  });

  // Plain text messages: only reached when no conversation is actively waiting for this chat.
  bot.on("message:text", async (ctx) => {
    const address = extractAddress(ctx.message.text);
    if (address) {
      await handleAddressInput(ctx, ctx.message.text);
      return;
    }
    await ctx.reply(
      "🤔 I didn't recognize that. Paste a token contract address to get started, or use the menu below.",
      { reply_markup: mainMenu }
    );
  });
}
