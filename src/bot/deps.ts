import type { Logger } from "pino";
import { DexScreenerClient } from "../data/dexscreener.js";
import { DigestRepo } from "../data/digestRepo.js";
import { RuleRepo } from "../data/ruleRepo.js";
import { SettingsRepo } from "../data/settingsRepo.js";
import { SnapshotRepo } from "../data/snapshotRepo.js";
import { TokenRepo } from "../data/tokenRepo.js";
import { WatchRepo } from "../data/watchRepo.js";

/**
 * Process-wide singleton dependency bundle. We deliberately do NOT attach this to
 * grammY's `ctx`, because @grammyjs/conversations replays conversation functions
 * against reconstructed contexts that only carry state from middleware explicitly
 * re-registered via `conversation.run(...)`. Since these dependencies are plain
 * stateless-per-request singletons (repos wrapping one shared DB connection, one
 * HTTP client), a module-level singleton is simpler and immune to that replay pitfall.
 */
export interface AppDeps {
  tokenRepo: TokenRepo;
  watchRepo: WatchRepo;
  ruleRepo: RuleRepo;
  snapshotRepo: SnapshotRepo;
  settingsRepo: SettingsRepo;
  digestRepo: DigestRepo;
  dex: DexScreenerClient;
  logger: Logger;
}

let deps: AppDeps | undefined;

export function setDeps(d: AppDeps): void {
  deps = d;
}

export function getDeps(): AppDeps {
  if (!deps) throw new Error("AppDeps accessed before initialization");
  return deps;
}
