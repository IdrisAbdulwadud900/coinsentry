/**
 * One-off resumable backfill: retroactively determines the origin factory for every
 * tracked token that predates factory_address being captured at discovery time, by
 * probing `graduationStatus(token)` against every known factory — only the token's
 * true origin factory will resolve successfully (others revert), and the multicall's
 * `allowFailure` mode means a probe against the wrong factory just gets skipped rather
 * than aborting the batch. As a side effect, each resolved token also gets its initial
 * graduation state populated for free, from the very same call.
 *
 * Safe to interrupt and re-run: only tokens with factory_address still NULL are
 * re-queried each run, so already-resolved tokens are never re-probed.
 *
 * Run with: npm run backfill:factory-address
 */
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/data/db.js";
import { createChainClient, readGraduationStatuses } from "../src/data/chainClient.js";
import { TokenRepo } from "../src/data/tokenRepo.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, transport: { target: "pino-pretty" } });

  const db = openDatabase(config.DB_PATH);
  const chainClient = createChainClient(config.ROBINHOOD_RPC_URL);
  const tokenRepo = new TokenRepo(db);

  const factories = [config.PONS_FACTORY_ACTIVE, config.PONS_FACTORY_LEGACY];
  const missing = tokenRepo.listMissingFactoryAddress();

  logger.info({ count: missing.length, factories }, "Starting factory-address backfill");

  if (missing.length === 0) {
    logger.info("No tokens missing factory_address, nothing to do");
    db.close();
    return;
  }

  // Probe every candidate factory per token; readGraduationStatuses only returns
  // entries for calls that succeeded, so at most one result comes back per token
  // (the true origin factory) unless both factories happen to revert for other reasons.
  const calls = missing.flatMap((token) =>
    factories.map((factoryAddress) => ({ factoryAddress, tokenAddress: token.address }))
  );

  const now = Date.now();
  const results = await readGraduationStatuses(chainClient, calls, config.GRADUATION_CHECK_BATCH_SIZE, logger);

  const resolvedAddresses = new Set<string>();
  for (const result of results) {
    if (resolvedAddresses.has(result.tokenAddress)) {
      // Both factories resolved for this token (shouldn't happen in practice) — keep
      // the first result and log so it can be investigated manually.
      logger.warn({ address: result.tokenAddress }, "Token resolved against more than one factory, keeping first");
      continue;
    }
    resolvedAddresses.add(result.tokenAddress);

    tokenRepo.setFactoryAddress(result.tokenAddress, result.factoryAddress);
    if (result.graduated) {
      tokenRepo.markGraduated(result.tokenAddress, result.pairedWei.toString(), result.thresholdWei.toString(), now);
    } else {
      tokenRepo.updateGraduationProgress(
        result.tokenAddress,
        result.pairedWei.toString(),
        result.thresholdWei.toString(),
        now
      );
    }
  }

  const unresolved = missing.length - resolvedAddresses.size;
  logger.info(
    { checked: missing.length, resolved: resolvedAddresses.size, unresolved },
    "Factory-address backfill complete"
  );
  if (unresolved > 0) {
    logger.warn(
      { unresolved },
      "Some tokens didn't resolve against either known factory this run (transient RPC failure, or a token from neither factory) — re-run the script to retry them"
    );
  }

  db.close();
}

main().catch((err) => {
  console.error("Factory-address backfill script failed:", err);
  process.exit(1);
});
