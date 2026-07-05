/** Abstraction the engine uses to push messages to Telegram without depending on grammY directly. */
export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface Notifier {
  /** Sends an HTML-formatted alert message with an optional row of inline buttons. */
  sendAlert(chatId: number, html: string, buttons?: InlineButton[]): Promise<void>;
}
