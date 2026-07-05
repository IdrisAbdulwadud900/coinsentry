import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineButton, Notifier } from "../engine/notifier.js";

export function createNotifier(api: Api): Notifier {
  return {
    async sendAlert(chatId: number, html: string, buttons?: InlineButton[]): Promise<void> {
      let keyboard: InlineKeyboard | undefined;
      if (buttons && buttons.length > 0) {
        keyboard = new InlineKeyboard();
        for (const button of buttons) {
          keyboard.text(button.text, button.callbackData);
        }
      }

      await api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      });
    },
  };
}
