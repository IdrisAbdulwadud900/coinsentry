import type { BotContext, MyConversation } from "../context.js";
import { getDeps } from "../deps.js";
import { cb } from "../callbackData.js";
import { backToMenuKeyboard } from "../cards.js";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function quietHoursConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "🕐 What time should quiet hours start? Reply in 24h <code>HH:MM</code> format (e.g. <code>22:00</code>), or send <code>off</code> to disable quiet hours.",
    { parse_mode: "HTML" }
  );

  const startCtx = await conversation.waitFor("message:text");
  const startText = startCtx.message.text.trim().toLowerCase();

  if (startText === "off") {
    await conversation.external(() =>
      getDeps().settingsRepo.upsert(chatId, { quiet_hours_start: null, quiet_hours_end: null })
    );
    await startCtx.reply("🔕 Quiet hours disabled.", { reply_markup: backToMenuKeyboard() });
    return;
  }

  if (!TIME_RE.test(startText)) {
    await startCtx.reply("That doesn't look like HH:MM. Please try /settings again.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  await startCtx.reply("And when should quiet hours end? (<code>HH:MM</code>)", { parse_mode: "HTML" });
  const endCtx = await conversation.waitFor("message:text");
  const endText = endCtx.message.text.trim();

  if (!TIME_RE.test(endText)) {
    await endCtx.reply("That doesn't look like HH:MM. Please try /settings again.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  await conversation.external(() =>
    getDeps().settingsRepo.upsert(chatId, { quiet_hours_start: startText, quiet_hours_end: endText })
  );

  await endCtx.reply(
    `🔕 Quiet hours set: ${startText}–${endText}. Alerts during that window will be queued and sent as a digest afterward.`,
    { reply_markup: backToMenuKeyboard() }
  );
}

export async function timezoneConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "🌍 What timezone should I use for your quiet hours? Send an IANA timezone name, e.g. <code>America/New_York</code>, <code>Europe/London</code>, <code>Asia/Singapore</code>.",
    { parse_mode: "HTML" }
  );

  const tzCtx = await conversation.waitFor("message:text");
  const tz = tzCtx.message.text.trim();

  if (!isValidTimezone(tz)) {
    await tzCtx.reply("I don't recognize that timezone. Please try /settings again with a valid IANA name.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  await conversation.external(() => getDeps().settingsRepo.upsert(chatId, { timezone: tz }));
  await tzCtx.reply(`🌍 Timezone set to ${tz}.`, { reply_markup: backToMenuKeyboard() });
}

export function isSettingsQuietHoursTrigger(data: string): boolean {
  return data === cb.settingsQuietHours();
}
