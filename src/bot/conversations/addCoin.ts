import type { BotContext, MyConversation } from "../context.js";
import { handleAddressInput } from "../handlers/addressInput.js";

export async function addCoinConversation(conversation: MyConversation, ctx: BotContext): Promise<void> {
  await ctx.reply("Paste the token's contract address:");
  const next = await conversation.waitFor("message:text");
  await handleAddressInput(next, next.message.text);
}
