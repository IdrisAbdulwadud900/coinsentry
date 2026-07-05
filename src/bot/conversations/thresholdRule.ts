import type { BotContext, MyConversation } from "../context.js";
import { getDeps } from "../deps.js";
import { fetchLiveMarket } from "../marketLookup.js";
import { cb } from "../callbackData.js";
import { confirmationKeyboard, directionKeyboard, modeKeyboard, backToMenuKeyboard } from "../cards.js";
import { editMessageTextIgnoringNoop } from "../safeEdit.js";
import { metricLabel } from "../../engine/alertMessages.js";
import { DEFAULT_HYSTERESIS_PCT } from "../../engine/defaults.js";
import { parseShorthandNumber, formatCompactUsd } from "../../util/numberParser.js";
import type { RuleMode, ThresholdCondition, ThresholdConfig, ThresholdMetric, TokenRow } from "../../types/domain.js";

function parseEntryData(data: string): { metric: ThresholdMetric; tokenId: number } | null {
  const parts = data.split(":");
  const code = parts[2];
  const tokenId = Number(parts[3]);
  if (!Number.isFinite(tokenId)) return null;
  const metric: ThresholdMetric | null = code === "mcap" ? "mcap" : code === "price" ? "price" : code === "liq" ? "liquidity" : null;
  if (!metric) return null;
  return { metric, tokenId };
}

export async function thresholdRuleConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data || !chatId) return;

  const entry = parseEntryData(data);
  if (!entry) return;
  const { metric, tokenId } = entry;

  await ctx.answerCallbackQuery();

  const token = await conversation.external(() => getDeps().tokenRepo.findById(tokenId));
  if (!token) {
    await ctx.editMessageText("This token is no longer available.", { reply_markup: backToMenuKeyboard() });
    return;
  }

  const label = metricLabel(metric);

  while (true) {
    await editMessageTextIgnoringNoop(ctx, `${label} alert for <b>${token.symbol}</b>\n\nPick a direction:`, {
      parse_mode: "HTML",
      reply_markup: directionKeyboard(),
    });

    const dirCtx = await conversation.waitForCallbackQuery([cb.ruleDirBelow(), cb.ruleDirAbove()]);
    await dirCtx.answerCallbackQuery();
    const condition: ThresholdCondition = dirCtx.callbackQuery.data === cb.ruleDirBelow() ? "below" : "above";

    await dirCtx.editMessageText(
      `Type the ${label} target value (e.g. <code>5k</code>, <code>250k</code>, <code>1.2m</code>, <code>0.0045</code>):`,
      { parse_mode: "HTML" }
    );

    const valueMsgCtx = await conversation.waitFor("message:text");
    const value = parseShorthandNumber(valueMsgCtx.message.text);
    if (value === null) {
      await valueMsgCtx.reply("Couldn't parse that number. Let's start over.");
      continue;
    }
    if (value <= 0) {
      await valueMsgCtx.reply("Please enter a value greater than 0. Let's start over.");
      continue;
    }

    const modeMsgCtx = await valueMsgCtx.reply("Fire mode?", { reply_markup: modeKeyboard() });
    const modeCtx = await conversation.waitForCallbackQuery([cb.ruleModeOneShot(), cb.ruleModeRepeating()]);
    await modeCtx.answerCallbackQuery();
    const mode: RuleMode = modeCtx.callbackQuery.data === cb.ruleModeOneShot() ? "one_shot" : "repeating";

    const config: ThresholdConfig = {
      kind: "threshold",
      metric,
      condition,
      value,
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
      deps.ruleRepo.create(chatId, watch.id, token.id, "threshold", config);
    });

    await confirmCtx.editMessageText(
      `✅ Rule created! I'll alert you when <b>${token.symbol}</b>'s ${label} ${
        condition === "below" ? "drops to" : "rises to"
      } ${formatCompactUsd(value)}.`,
      { parse_mode: "HTML", reply_markup: backToMenuKeyboard() }
    );
    return;
  }
}

function buildSummary(token: TokenRow, config: ThresholdConfig): string {
  const label = metricLabel(config.metric);
  const verb = config.condition === "below" ? "drops to or below" : "rises to or above";
  return [
    `<b>Confirm alert</b>`,
    `${token.symbol}: notify when ${label} ${verb} ${formatCompactUsd(config.value)}`,
    `Mode: ${config.mode === "one_shot" ? "🔂 One-shot" : "🔁 Repeating"}`,
  ].join("\n");
}
