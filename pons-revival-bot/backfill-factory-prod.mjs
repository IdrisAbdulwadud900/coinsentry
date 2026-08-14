import pino from "pino";
import { loadConfig } from "./dist/config.js";
import { openDatabase } from "./dist/data/db.js";
import { createChainClient, readGraduationStatuses } from "./dist/data/chainClient.js";
import { TokenRepo } from "./dist/data/tokenRepo.js";

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDatabase(config.DB_PATH);
  const chainClient = createChainClient(config.ROBINHOOD_RPC_URL);
  const tokenRepo = new TokenRepo(db);

  const factories = [config.PONS_FACTORY_ACTIVE, config.PONS_FACTORY_LEGACY];
  const missing = tokenRepo.listMissingFactoryAddress();

  logger.info({ count: missing.length, factories }, "Starting PRODUCTION factory-address backfill");

  if (missing.length === 0) {
    logger.info("No tokens missing factory_address, nothing to do");
    db.close();
    return;
  }

  const calls = missing.flatMap((token) =>
    factories.map((factoryAddress) => ({ factoryAddress, tokenAddress: token.address }))
  );

  const now = Date.now();
  const results = await readGraduationStatuses(chainClient, calls, config.GRADUATION_CHECK_BATCH_SIZE, logger);

  const resolvedAddresses = new Set();
  for (const result of results) {
    if (resolvedAddresses.has(result.tokenAddress)) {
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
    "PRODUCTION factory-address backfill complete"
  );
  if (unresolved > 0) {
    logger.warn({ unresolved }, "Some tokens didn't resolve against either known factory this run");
  }

  db.close();
}

main().catch((err) => {
  console.error("PRODUCTION factory-address backfill script failed:", err);
  process.exit(1);
});
