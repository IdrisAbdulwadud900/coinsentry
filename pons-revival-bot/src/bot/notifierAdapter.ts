import { InputFile, type Api } from "grammy";
import type { Logger } from "pino";
import type { Notifier, SendAlertOptions } from "../engine/notifier.js";

const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * Attempts to send one candidate image, trying two strategies in order:
 * 1. Pass the URL straight to Telegram (cheapest — Telegram fetches it server-side).
 * 2. If Telegram's fetcher rejects it (common with DexScreener's CDN, which often
 *    refuses Telegram's server-side requests), download the bytes ourselves and
 *    re-upload them as a file.
 * Returns true on success so the caller can stop at the first working candidate.
 */
async function trySendPhoto(api: Api, chatId: string, imageUrl: string, logger?: Logger): Promise<boolean> {
  try {
    await api.sendPhoto(chatId, imageUrl);
    return true;
  } catch (err) {
    logger?.warn({ err: String(err), imageUrl }, "Telegram couldn't fetch alert image by URL, retrying via direct upload");
  }
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
    if (!res.ok) throw new Error(`image fetch responded ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error("image fetch returned an empty body");
    await api.sendPhoto(chatId, new InputFile(bytes, "token-image.jpg"));
    return true;
  } catch (err) {
    logger?.warn({ err: String(err), imageUrl }, "Alert image candidate failed after direct-upload fallback");
    return false;
  }
}

export function createNotifier(api: Api, logger?: Logger): Notifier {
  return {
    async sendAlert(chatId: string, html: string, options?: SendAlertOptions): Promise<void> {
      // Sent as a separate message rather than a caption on the text alert below:
      // Telegram photo captions cap at 1024 chars, well under what this bot's alert
      // HTML can reach. Candidates are tried best-source-first until one sends; if
      // every candidate fails, the text alert still goes out.
      for (const imageUrl of options?.imageUrls ?? []) {
        if (await trySendPhoto(api, chatId, imageUrl, logger)) break;
      }

      await api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    },
  };
}
