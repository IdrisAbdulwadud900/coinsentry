import { GrammyError } from "grammy";
import type { BotContext } from "./context.js";

/**
 * Edits the current message, ignoring Telegram's "message is not modified" error.
 * This can happen when re-fetching data (e.g. price) and redrawing an identical
 * prompt (e.g. after an invalid text reply) produces byte-identical content.
 */
export async function editMessageTextIgnoringNoop(
  ctx: BotContext,
  text: string,
  other: Parameters<BotContext["editMessageText"]>[1]
): Promise<void> {
  try {
    await ctx.editMessageText(text, other);
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) {
      return;
    }
    throw err;
  }
}
