import type { Context } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";

export type BotContext = Context & ConversationFlavor<Context>;
export type MyConversation = Conversation<BotContext, BotContext>;
