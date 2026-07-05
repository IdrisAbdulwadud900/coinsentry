import { InlineKeyboard } from "grammy";
import type { BotContext } from "./context.js";
import { getDeps } from "./deps.js";
import { fetchLiveMarket } from "./marketLookup.js";
import { cb } from "./callbackData.js";
import {
  backToMenuKeyboard,
  helpText,
  marketCardText,
  newTokenCardKeyboard,
  rulesListKeyboard,
  rulesListText,
  watchedTokenCardKeyboard,
  watchlistKeyboard,
  watchlistText,
} from "./cards.js";

export const WATCHLIST_PAGE_SIZE = 5;

export async function showHelp(ctx: BotContext): Promise<void> {
  const text = helpText();
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backToMenuKeyboard() });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: backToMenuKeyboard() });
  }
}

export async function showSettings(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const settings = getDeps().settingsRepo.get(chatId);

  const quietText =
    settings.quiet_hours_start && settings.quiet_hours_end
      ? `${settings.quiet_hours_start}–${settings.quiet_hours_end} (${settings.timezone ?? "UTC"})`
      : "off";

  const text = [
    "⚙️ <b>Settings</b>",
    "",
    `Quiet hours: ${quietText}`,
    `Timezone: ${settings.timezone ?? "UTC"}`,
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("🕐 Set quiet hours", cb.settingsQuietHours())
    .row()
    .text("🌍 Set timezone", cb.settingsTimezone())
    .row()
    .text("« Main menu", cb.mainMenu());

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
}

export async function showWatchlistPage(ctx: BotContext, page: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const { watchRepo, tokenRepo } = getDeps();

  const allWatches = watchRepo.listForChat(chatId);
  const totalPages = Math.max(Math.ceil(allWatches.length / WATCHLIST_PAGE_SIZE), 1);
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageWatches = allWatches.slice(
    clampedPage * WATCHLIST_PAGE_SIZE,
    clampedPage * WATCHLIST_PAGE_SIZE + WATCHLIST_PAGE_SIZE
  );

  const rows = await Promise.all(
    pageWatches.map(async (watch) => {
      const token = tokenRepo.findById(watch.token_id);
      if (!token) return null;
      const market = await fetchLiveMarket(token);
      const ruleCount = watchRepo.countRules(watch.id);
      return { watch, token, market, ruleCount };
    })
  );
  const validRows = rows.filter((r): r is NonNullable<typeof r> => r !== null);

  const text =
    allWatches.length === 0
      ? "📋 <b>My watchlist</b>\n\nYou're not watching any coins yet. Paste a contract address to get started."
      : watchlistText(clampedPage, totalPages);
  const keyboard =
    allWatches.length === 0
      ? new InlineKeyboard().text("➕ Add coin", cb.addCoin()).row().text("« Main menu", cb.mainMenu())
      : watchlistKeyboard(validRows, clampedPage, totalPages);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
}

export async function showTokenCard(ctx: BotContext, tokenId: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const { tokenRepo, watchRepo } = getDeps();

  const token = tokenRepo.findById(tokenId);
  if (!token) {
    await ctx.editMessageText("This token is no longer available.", { reply_markup: backToMenuKeyboard() });
    return;
  }

  const market = await fetchLiveMarket(token);
  if (!market) {
    await ctx.editMessageText(
      `⚠️ Couldn't fetch live data for ${token.symbol} right now. It may no longer be indexed.`,
      { reply_markup: backToMenuKeyboard() }
    );
    return;
  }

  const watch = watchRepo.findByChatAndToken(chatId, tokenId);
  const text = marketCardText(market);
  const keyboard = watch ? watchedTokenCardKeyboard(watch.id, token.id) : newTokenCardKeyboard(token.id);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
  }
}

export async function showRulesList(ctx: BotContext, watchId: number): Promise<void> {
  const { watchRepo, tokenRepo, ruleRepo } = getDeps();
  const watch = watchRepo.findById(watchId);
  if (!watch) {
    await ctx.editMessageText("This watch no longer exists.", { reply_markup: backToMenuKeyboard() });
    return;
  }
  const token = tokenRepo.findById(watch.token_id);
  if (!token) {
    await ctx.editMessageText("This token no longer exists.", { reply_markup: backToMenuKeyboard() });
    return;
  }
  const rules = ruleRepo.listForWatch(watchId);
  await ctx.editMessageText(rulesListText(token, rules), {
    parse_mode: "HTML",
    reply_markup: rulesListKeyboard(watchId, token.id, rules),
  });
}
