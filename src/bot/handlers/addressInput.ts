import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { extractAddress } from "../addressDetect.js";
import { getDeps } from "../deps.js";
import { pickCanonicalPair, toMarketSnapshot } from "../marketLookup.js";
import { cb } from "../callbackData.js";
import { marketCardText, newTokenCardKeyboard, backToMenuKeyboard } from "../cards.js";

/** Shared entry point for both the /start "Add coin" conversation and plain-text CA pastes. */
export async function handleAddressInput(ctx: BotContext, rawText: string): Promise<void> {
  const address = extractAddress(rawText);
  if (!address) {
    await ctx.reply(
      "🤔 That doesn't look like a contract address. Paste a token's contract address (Solana, Ethereum, BSC, Base, pump.fun, etc.) and I'll pull it up for you.",
      { reply_markup: new InlineKeyboard().text("➕ Add coin", cb.addCoin()) }
    );
    return;
  }

  const { dex, tokenRepo, logger } = getDeps();
  await ctx.replyWithChatAction("typing").catch(() => undefined);

  let pairs;
  try {
    pairs = await dex.lookupAddress(address);
  } catch (err) {
    logger.error({ err: String(err) }, "lookupAddress failed");
    await ctx.reply("⚠️ Couldn't reach DexScreener right now. Please try again in a moment.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const canonical = pickCanonicalPair(pairs);
  if (!canonical) {
    await ctx.reply(
      "😕 Couldn't find that token on DexScreener. It might be brand new, not yet indexed, or the address might be wrong.",
      { reply_markup: new InlineKeyboard().text("➕ Try another", cb.addCoin()) }
    );
    return;
  }

  const market = toMarketSnapshot(canonical, address);
  const token = tokenRepo.upsertFromMarket(market);

  await ctx.reply(marketCardText(market), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: newTokenCardKeyboard(token.id),
  });
}
