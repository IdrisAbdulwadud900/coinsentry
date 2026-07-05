import type { BotContext, MyConversation } from "../context.js";
import { getDeps } from "../deps.js";
import { fetchLiveMarket } from "../marketLookup.js";
import { cb } from "../callbackData.js";
import { confirmationKeyboard, trendDirectionKeyboard, trendModeKeyboard, backToMenuKeyboard } from "../cards.js";
import { editMessageTextIgnoringNoop } from "../safeEdit.js";
import { DEFAULT_TREND_PARAMS } from "../../engine/defaults.js";
import { parseShorthandNumber } from "../../util/numberParser.js";
import type { TokenRow, TrendConfig, TrendDirection } from "../../types/domain.js";

interface Replier {
  reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

async function askNumber(
  conversation: MyConversation,
  promptCtx: Replier,
  question: string,
  min: number,
  max: number
): Promise<number> {
  await promptCtx.reply(question);
  while (true) {
    const msgCtx = await conversation.waitFor("message:text");
    const value = parseShorthandNumber(msgCtx.message.text);
    if (value !== null && value >= min && value <= max) return value;
    await msgCtx.reply(`Please enter a number between ${min} and ${max}.`);
  }
}

export async function trendRuleConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
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
    await editMessageTextIgnoringNoop(ctx, `📈 Trend alert for <b>${token.symbol}</b>\n\nWhich direction?`, {
      parse_mode: "HTML",
      reply_markup: trendDirectionKeyboard(),
    });

    const dirCtx = await conversation.waitForCallbackQuery([cb.ruleTrendUp(), cb.ruleTrendDown()]);
    await dirCtx.answerCallbackQuery();
    const direction: TrendDirection = dirCtx.callbackQuery.data === cb.ruleTrendUp() ? "up" : "down";

    await dirCtx.editMessageText("Use the default sensitivity, or customize the parameters?", {
      reply_markup: trendModeKeyboard(),
    });

    const modeCtx = await conversation.waitForCallbackQuery([cb.ruleTrendDefault(), cb.ruleTrendCustom()]);
    await modeCtx.answerCallbackQuery();

    let params = { ...DEFAULT_TREND_PARAMS };

    if (modeCtx.callbackQuery.data === cb.ruleTrendCustom()) {
      await modeCtx.editMessageText("Let's customize the trend parameters. I'll ask for each one.");
      const label = direction === "up" ? "rise" : "drop";
      const m5ChangePct = await askNumber(
        conversation,
        modeCtx,
        `Minimum 5-minute price ${label} % to trigger (default ${DEFAULT_TREND_PARAMS.m5ChangePct}):`,
        0.1,
        100
      );
      const h1ChangePct = await askNumber(
        conversation,
        modeCtx,
        `Minimum 1-hour price change % in the same direction, so it's not fighting a bigger opposite trend (default ${DEFAULT_TREND_PARAMS.h1ChangePct}):`,
        0,
        100
      );
      const volumeMultiplier = await askNumber(
        conversation,
        modeCtx,
        `Volume spike multiplier vs the recent average (default ${DEFAULT_TREND_PARAMS.volumeMultiplier}x):`,
        1,
        50
      );
      const consecutivePolls = await askNumber(
        conversation,
        modeCtx,
        `How many consecutive polls of ${direction === "up" ? "rising" : "falling"} price required (default ${DEFAULT_TREND_PARAMS.consecutivePolls}):`,
        2,
        20
      );
      const cooldownMinutes = await askNumber(
        conversation,
        modeCtx,
        `Cooldown in minutes before this alert can fire again (default ${DEFAULT_TREND_PARAMS.cooldownMinutes}):`,
        1,
        1440
      );
      params = { m5ChangePct, h1ChangePct, volumeMultiplier, consecutivePolls, cooldownMinutes };
    }

    const config: TrendConfig = { kind: "trend", direction, ...params };
    const summary = buildSummary(token, config);

    await modeCtx.reply(summary, { parse_mode: "HTML", reply_markup: confirmationKeyboard() });

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

    const market = await conversation.external(() => fetchLiveMarket(token));
    if (!market) {
      await confirmCtx.editMessageText("Couldn't fetch live data for this token right now. Try again later.", {
        reply_markup: backToMenuKeyboard(),
      });
      return;
    }

    await conversation.external(() => {
      const deps = getDeps();
      const watch = deps.watchRepo.getOrCreate(chatId, token.id, market);
      deps.ruleRepo.create(chatId, watch.id, token.id, "trend", config);
    });

    await confirmCtx.editMessageText(
      `✅ Rule created! I'll alert you when <b>${token.symbol}</b> starts ${direction === "up" ? "an uptrend" : "a downtrend"}.`,
      { parse_mode: "HTML", reply_markup: backToMenuKeyboard() }
    );
    return;
  }
}

function buildSummary(token: TokenRow, config: TrendConfig): string {
  const dirLabel = config.direction === "up" ? "📈 Uptrend" : "📉 Downtrend";
  return [
    `<b>Confirm alert</b>`,
    `${token.symbol}: ${dirLabel} detection`,
    `5m change ≥ ${config.m5ChangePct}% | 1h change ≥ ${config.h1ChangePct}%`,
    `Volume ≥ ${config.volumeMultiplier}x avg | ${config.consecutivePolls} consecutive polls`,
    `Cooldown: ${config.cooldownMinutes} min`,
  ].join("\n");
}
