export interface SendAlertOptions {
  /** Plain DexScreener link, already present as a text link in the HTML body — kept here only
   * for future use, not currently rendered as a button. */
  dexScreenerUrl?: string;
  /** Ordered candidate token image/icon URLs, best source first. The adapter tries each
   * in turn (URL send, then direct-upload fallback) and stops at the first that Telegram
   * accepts, so an alert shows an image whenever ANY source has one. Sent as a separate
   * photo message before the text alert (never embedded in the caption — Telegram's
   * 1024-char photo caption limit is smaller than this bot's alert HTML often is). */
  imageUrls?: string[];
}

/** Abstraction the engine uses to push alert messages to Telegram without depending on grammY directly. */
export interface Notifier {
  /** Sends an HTML-formatted alert message. */
  sendAlert(chatId: string, html: string, options?: SendAlertOptions): Promise<void>;
}
