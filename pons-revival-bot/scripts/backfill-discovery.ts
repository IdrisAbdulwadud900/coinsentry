/**
 * One-off resumable backfill: scans both Pons factory contracts from their
 * launch blocks to the current chain head for TokenLaunched events, looks up
 * each discovered token on DexScreener, and persists them into the `tokens`
 * table. Safe to interrupt and re-run — progress is persisted per-factory in
 * `discovery_state` after every internal chunk batch of the run.
 *
 * Run with: npm run backfill
 */
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/data/db.js";
import { createChainClient } from "../src/data/chainClient.js";
import { DiscoveryStateRepo } from "../src/data/discoveryStateRepo.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { DexScreenerClient } from "../src/data/dexscreener.js";
import { runDiscovery, type FactoryConfig } from "../src/data/tokenDiscovery.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, transport: { target: "pino-pretty" } });

  const db = openDatabase(config.DB_PATH);
  const chainClient = createChainClient(config.ROBINHOOD_RPC_URL);
  const discoveryStateRepo = new DiscoveryStateRepo(db);
  const tokenRepo = new TokenRepo(db);
  const dex = new DexScreenerClient(logger.child({ module: "dexscreener" }));

  const factories: FactoryConfig[] = [
    { address: config.PONS_FACTORY_ACTIVE, startBlock: BigInt(config.PONS_FACTORY_ACTIVE_START_BLOCK) },
    { address: config.PONS_FACTORY_LEGACY, startBlock: BigInt(config.PONS_FACTORY_LEGACY_START_BLOCK) },
  ];

  logger.info({ factories: factories.map((f) => f.address) }, "Starting Pons token discovery backfill");

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
  logger.info({ insertedThisRun: inserted, totalTokensInDb: allTokens.length }, "Backfill complete");
  console.log("\nSample of discovered tokens:");
  for (const t of allTokens.slice(0, 20)) {
    console.log(`  ${t.symbol.padEnd(12)} ${t.address}  pair=${t.pair_address}`);
  }

  db.close();
}

main().catch((err) => {
  console.error("Backfill script failed:", err);
  process.exit(1);
});
