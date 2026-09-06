import type { Logger } from "pino";
import type { TokenRepo } from "../data/tokenRepo.js";
import type { SettingsRepo } from "../data/settingsRepo.js";
import type { OutcomeRepo } from "../data/outcomeRepo.js";
import type { Poller } from "../engine/poller.js";
import type { ClassifierConfig } from "../engine/classifier.js";

/** Process-wide singleton dependency bundle, exposed to grammY command handlers. */
export interface AppDeps {
  tokenRepo: TokenRepo;
  poller: Poller;
  logger: Logger;
  settingsRepo: SettingsRepo;
  outcomeRepo: OutcomeRepo;
  classifierConfig: ClassifierConfig;
  /** Telegram user ID of the bot's owner (currently reuses TELEGRAM_CHAT_ID, the single
   * chat every alert is sent to). Used to gate /setconfig and /resetconfig. */
  telegramChatId: string;
}

let deps: AppDeps | undefined;

export function setDeps(d: AppDeps): void {
  deps = d;
}

export function getDeps(): AppDeps {
  if (!deps) throw new Error("AppDeps accessed before initialization");
  return deps;
}
