import type { BotContext, MyConversation } from "../context.js";
import { getDeps } from "../deps.js";
import { fetchLiveMarket } from "../marketLookup.js";
import { cb } from "../callbackData.js";
import { confirmationKeyboard, modeKeyboard, backToMenuKeyboard } from "../cards.js";
import { editMessageTextIgnoringNoop } from "../safeEdit.js";
import { DEFAULT_HYSTERESIS_PCT } from "../../engine/defaults.js";
import { parseShorthandNumber, formatCompactUsd } from "../../util/numberParser.js";
import type { PercentMoveConfig, RuleMode, TokenRow } from "../../types/domain.js";

export async function percentMoveRuleConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data || !chatId) return;

  const tokenId = Number(data.split(":")[3]);
  if (!Number.isFinite(tokenId)) return;

  await ctx.answerCallbackQuery();

  const token = await conversation.external(() => getDeps().tokenRepo.findById(tokenId));
  if (!token) {
    await ctx.editMessageText("This token is no longer available.", { reply_markup: backToMenuKeyboard() });
    return;
  }

  while (true) {
    const market = await conversation.external(() => fetchLiveMarket(token));
    if (!market) {
      await ctx.editMessageText("Couldn't fetch live data for this token right now. Try again later.", {
        reply_markup: backToMenuKeyboard(),
      });
      return;
    }

    await editMessageTextIgnoringNoop(
      ctx,
      `↕️ % Move alert for <b>${token.symbol}</b>\n\nCurrent price: ${formatCompactUsd(market.priceUsd)}\n\nType the percent move to watch for (e.g. <code>10</code> for ±10%):`,
      { parse_mode: "HTML" }
    );

    const pctMsgCtx = await conversation.waitFor("message:text");
    const rawPercent = parseShorthandNumber(pctMsgCtx.message.text.replace("%", ""));
    if (rawPercent === null) {
      await pctMsgCtx.reply("Couldn't parse that percentage. Let's start over.");
      continue;
    }
    const percent = Math.abs(rawPercent);
    if (percent === 0 || percent > 1000) {
      await pctMsgCtx.reply("Please enter a percentage between 0 and 1000. Let's start over.");
      continue;
    }

    const modeMsgCtx = await pctMsgCtx.reply("Fire mode?", { reply_markup: modeKeyboard() });
    const modeCtx = await conversation.waitForCallbackQuery([cb.ruleModeOneShot(), cb.ruleModeRepeating()]);
    await modeCtx.answerCallbackQuery();
    const mode: RuleMode = modeCtx.callbackQuery.data === cb.ruleModeOneShot() ? "one_shot" : "repeating";

    const config: PercentMoveConfig = {
      kind: "percent_move",
      basePrice: market.priceUsd,
      percent,
      mode,
      hysteresisPct: DEFAULT_HYSTERESIS_PCT,
    };

    const summary = buildSummary(token, config);
    await ctx.api.editMessageText(modeMsgCtx.chat.id, modeMsgCtx.message_id, summary, {
      parse_mode: "HTML",
      reply_markup: confirmationKeyboard(),
    });

    const confirmCtx = await conversation.waitForCallbackQuery([
      cb.confirmYes(),
      cb.confirmEdit(),
      cb.confirmCancel(),
    ]);
    await confirmCtx.answerCallbackQuery();

    if (confirmCtx.callbackQuery.data === cb.confirmCancel()) {
      await confirmCtx.editMessageText("Cancelled.", { reply_markup: backToMenuKeyboard() });
      return;
    }
    if (confirmCtx.callbackQuery.data === cb.confirmEdit()) {
      continue;
    }

    await conversation.external(() => {
      const deps = getDeps();
      const watch = deps.watchRepo.getOrCreate(chatId, token.id, market);
      deps.ruleRepo.create(chatId, watch.id, token.id, "percent_move", config);
    });

    await confirmCtx.editMessageText(
      `✅ Rule created! I'll alert you when <b>${token.symbol}</b> moves ±${percent}% from ${formatCompactUsd(market.priceUsd)}.`,
      { parse_mode: "HTML", reply_markup: backToMenuKeyboard() }
    );
    return;
  }
}

function buildSummary(token: TokenRow, config: PercentMoveConfig): string {
  return [
    `<b>Confirm alert</b>`,
    `${token.symbol}: notify on ±${config.percent}% move from ${formatCompactUsd(config.basePrice)}`,
    `Mode: ${config.mode === "one_shot" ? "🔂 One-shot" : "🔁 Repeating"}`,
  ].join("\n");
}
