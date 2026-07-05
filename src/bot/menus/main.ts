import { Menu } from "@grammyjs/menu";
import type { BotContext } from "../context.js";
import { welcomeText } from "../cards.js";
import { showHelp, showSettings, showWatchlistPage } from "../screens.js";

/**
 * The main menu is the one genuinely interactive @grammyjs/menu instance in the app
 * (flat, no submenus). All other screens (settings, watchlist, token cards, rules,
 * confirmations) are rendered with plain InlineKeyboards edited in place, since their
 * layout is highly data-dependent and simple callback_data handlers are a better fit.
 */
export const mainMenu = new Menu<BotContext>("main-menu")
  .text("➕ Add coin", (ctx) => ctx.conversation.enter("addCoin"))
  .text("📋 My watchlist", (ctx) => showWatchlistPage(ctx, 0))
  .row()
  .text("⚙️ Settings", (ctx) => showSettings(ctx))
  .text("❓ Help", (ctx) => showHelp(ctx));

export async function showMainMenu(ctx: BotContext): Promise<void> {
  const text = welcomeText();
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: mainMenu });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainMenu });
  }
}
