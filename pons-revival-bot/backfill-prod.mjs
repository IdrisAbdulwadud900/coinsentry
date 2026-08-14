import pino from "pino";
import { loadConfig } from "./dist/config.js";
import { openDatabase } from "./dist/data/db.js";
import { createChainClient } from "./dist/data/chainClient.js";
import { DiscoveryStateRepo } from "./dist/data/discoveryStateRepo.js";
import { TokenRepo } from "./dist/data/tokenRepo.js";
import { DexScreenerClient } from "./dist/data/dexscreener.js";
import { runDiscovery } from "./dist/data/tokenDiscovery.js";

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDatabase(config.DB_PATH);
  const chainClient = createChainClient(config.ROBINHOOD_RPC_URL);
  const discoveryStateRepo = new DiscoveryStateRepo(db);
  const tokenRepo = new TokenRepo(db);
  const dex = new DexScreenerClient(logger.child({ module: "dexscreener" }));

  const factories = [
    { address: config.PONS_FACTORY_ACTIVE, startBlock: BigInt(config.PONS_FACTORY_ACTIVE_START_BLOCK) },
    { address: config.PONS_FACTORY_LEGACY, startBlock: BigInt(config.PONS_FACTORY_LEGACY_START_BLOCK) },
  ];

  logger.info({ factories: factories.map((f) => f.address) }, "Starting PRODUCTION Pons token discovery backfill (genesis re-scan)");

  const inserted = await runDiscovery(
    {
      chainClient,
      discoveryStateRepo,
      tokenRepo,
      dex,
      dexScreenerChainId: config.ROBINHOOD_CHAIN_ID_DEXSCREENER,
      chunkBlocks: config.DISCOVERY_CHUNK_BLOCKS,
      minLiquidityUsd: config.DISCOVERY_MIN_LIQUIDITY_USD,
      spamDeployerThreshold: config.SPAM_DEPLOYER_THRESHOLD,
      logger,
    },
    factories
  );

  const allTokens = tokenRepo.listAll();
  logger.info({ insertedThisRun: inserted, totalTokensInDb: allTokens.length }, "PRODUCTION backfill complete");
  db.close();
}

main().catch((err) => {
  console.error("PRODUCTION backfill script failed:", err);
  process.exit(1);
});
