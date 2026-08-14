import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { DiscoveryStateRepo } from "../src/data/discoveryStateRepo.js";
import { runDiscovery, type DiscoveryDeps, type FactoryConfig } from "../src/data/tokenDiscovery.js";
import type { ChainClient, TokenLaunchedLog } from "../src/data/chainClient.js";
import type { DexScreenerClient } from "../src/data/dexscreener.js";

vi.mock("../src/data/chainClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/data/chainClient.js")>("../src/data/chainClient.js");
  return { ...actual, scanTokenLaunches: vi.fn(), readTokenIdentities: vi.fn(async () => []) };
});

import { scanTokenLaunches, readTokenIdentities } from "../src/data/chainClient.js";
import type { DexPair } from "../src/types/dexscreener.js";

const logger = pino({ level: "silent" });

const FACTORY_A: FactoryConfig = { address: "0xFactoryA", startBlock: 100n };
const FACTORY_B: FactoryConfig = { address: "0xFactoryB", startBlock: 200n };

function makeLaunch(address: string): TokenLaunchedLog {
  return { tokenAddress: address, deployerAddress: "0xDeployer", blockNumber: 150n };
}

function baseDeps(db: Db, overrides: Partial<DiscoveryDeps> = {}): { deps: DiscoveryDeps; discoveryStateRepo: DiscoveryStateRepo; tokenRepo: TokenRepo } {
  const discoveryStateRepo = new DiscoveryStateRepo(db);
  const tokenRepo = new TokenRepo(db);
  const deps: DiscoveryDeps = {
    chainClient: {} as unknown as ChainClient,
    discoveryStateRepo,
    tokenRepo,
    dex: { lookupBatch: vi.fn(async () => []) } as unknown as DexScreenerClient,
    dexScreenerChainId: "robinhood",
    chunkBlocks: 500_000,
    minLiquidityUsd: 200,
    spamDeployerThreshold: 15,
    identityBatchSize: 300,
    logger,
    ...overrides,
  };
  return { deps, discoveryStateRepo, tokenRepo };
}

describe("runDiscovery cursor persistence", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.mocked(scanTokenLaunches).mockReset();
  });

  it("advances both factories' cursors when the run completes successfully", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => ({
      launches: [makeLaunch(`0xToken-${factoryAddress}`)],
      reachedBlock: 999n,
    }));

    const { deps, discoveryStateRepo } = baseDeps(db);

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBe(1000n);
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_B.address)).toBe(1000n);
  });

  it("does NOT advance any cursor when the DexScreener lookup throws after scanning", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => ({
      launches: [makeLaunch(`0xToken-${factoryAddress}`)],
      reachedBlock: 999n,
    }));

    const { deps, discoveryStateRepo, tokenRepo } = baseDeps(db, {
      dex: {
        lookupBatch: vi.fn(async () => {
          throw new Error("DexScreener API down");
        }),
      } as unknown as DexScreenerClient,
    });

    await expect(runDiscovery(deps, [FACTORY_A, FACTORY_B])).rejects.toThrow("DexScreener API down");

    // Neither factory's cursor should have moved, even though scanning itself succeeded
    // for both, since the tokens discovered were never durably inserted.
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBeUndefined();
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_B.address)).toBeUndefined();
    expect(tokenRepo.listAll()).toHaveLength(0);
  });

  it("does NOT advance any cursor when inserting a discovered token throws", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => ({
      launches: [makeLaunch(`0xToken-${factoryAddress}`)],
      reachedBlock: 999n,
    }));

    const insertIfNew = vi.fn(() => {
      throw new Error("DB constraint violation");
    });
    const { deps, discoveryStateRepo } = baseDeps(db, {
      tokenRepo: { insertIfNew, countByDeployer: vi.fn(() => 0) } as unknown as TokenRepo,
    });

    await expect(runDiscovery(deps, [FACTORY_A, FACTORY_B])).rejects.toThrow("DB constraint violation");

    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBeUndefined();
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_B.address)).toBeUndefined();
  });

  it("advances cursors even when nothing new was discovered", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async () => ({ launches: [], reachedBlock: 999n }));

    const { deps, discoveryStateRepo } = baseDeps(db);

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBe(1000n);
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_B.address)).toBe(1000n);
  });

  it("retrying after a failed run picks up from the same un-advanced cursor and succeeds (idempotent, no duplicates)", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => ({
      launches: [makeLaunch("0xSameToken")],
      reachedBlock: 999n,
    }));

    let failLookup = true;
    const { deps, discoveryStateRepo, tokenRepo } = baseDeps(db, {
      dex: {
        lookupBatch: vi.fn(async () => {
          if (failLookup) throw new Error("transient failure");
          return [];
        }),
      } as unknown as DexScreenerClient,
    });

    await expect(runDiscovery(deps, [FACTORY_A, FACTORY_B])).rejects.toThrow("transient failure");
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBeUndefined();

    failLookup = false;
    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_A.address)).toBe(1000n);
    expect(discoveryStateRepo.getLastScannedBlock(FACTORY_B.address)).toBe(1000n);
    // Same token address discovered by both factory scans in this test collapses to one
    // row (Map keyed by address) — insertIfNew's INSERT OR IGNORE guarantees no duplicate.
    expect(tokenRepo.listAll()).toHaveLength(1);
  });
});

function makePair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: "robinhood",
    dexId: "someDex",
    pairAddress: "0xPair",
    baseToken: { address: "0xAAA", name: "Foo Token", symbol: "FOO" },
    liquidity: { usd: 1000 },
    ...overrides,
  };
}

describe("runDiscovery on-chain identity fallback", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.mocked(scanTokenLaunches).mockReset();
    vi.mocked(readTokenIdentities).mockReset();
    vi.mocked(readTokenIdentities).mockImplementation(async () => []);
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => {
      if (factoryAddress === FACTORY_A.address) {
        return { launches: [makeLaunch("0xAAA")], reachedBlock: 999n };
      }
      return { launches: [], reachedBlock: 999n };
    });
  });

  it("falls back to the on-chain name/symbol when DexScreener's pair lacks them", async () => {
    vi.mocked(readTokenIdentities).mockImplementation(async () => [
      { tokenAddress: "0xAAA", symbol: "BAR", name: "Bar Token" },
    ]);

    const { deps, tokenRepo } = baseDeps(db, {
      dex: {
        lookupBatch: vi.fn(async () => [makePair({ baseToken: { address: "0xAAA", name: undefined, symbol: undefined } })]),
      } as unknown as DexScreenerClient,
    });

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(vi.mocked(readTokenIdentities)).toHaveBeenCalledWith(
      deps.chainClient,
      ["0xaaa"],
      deps.identityBatchSize,
      deps.logger
    );
    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.symbol).toBe("BAR");
    expect(token?.name).toBe("Bar Token");
    expect(token?.status).toBe("active");
  });

  it("falls back to the placeholder '?' when neither DexScreener nor the on-chain read has an identity", async () => {
    vi.mocked(readTokenIdentities).mockImplementation(async () => []);

    const { deps, tokenRepo } = baseDeps(db, {
      dex: {
        lookupBatch: vi.fn(async () => [makePair({ baseToken: { address: "0xAAA", name: undefined, symbol: undefined } })]),
      } as unknown as DexScreenerClient,
    });

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.symbol).toBe("?");
    // name falls back through: pair name -> on-chain name -> on-chain symbol -> symbol ("?") -> "Unknown"
    expect(token?.name).toBe("?");
  });

  it("does not call the on-chain fallback when DexScreener already has a full identity", async () => {
    const { deps, tokenRepo } = baseDeps(db, {
      dex: {
        lookupBatch: vi.fn(async () => [makePair()]),
      } as unknown as DexScreenerClient,
    });

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(vi.mocked(readTokenIdentities)).not.toHaveBeenCalled();
    const token = tokenRepo.findByAddress("0xaaa");
    expect(token?.symbol).toBe("FOO");
    expect(token?.name).toBe("Foo Token");
  });
});

describe("runDiscovery launch_block threading", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.mocked(scanTokenLaunches).mockReset();
    vi.mocked(readTokenIdentities).mockReset();
    vi.mocked(readTokenIdentities).mockImplementation(async () => []);
  });

  it("persists the launch's block number (as a string) onto the newly discovered token", async () => {
    vi.mocked(scanTokenLaunches).mockImplementation(async (_client, factoryAddress) => {
      if (factoryAddress === FACTORY_A.address) {
        return { launches: [{ tokenAddress: "0xAAA", deployerAddress: "0xDeployer", blockNumber: 12345n }], reachedBlock: 999n };
      }
      return { launches: [], reachedBlock: 999n };
    });

    const { deps, tokenRepo } = baseDeps(db, {
      dex: { lookupBatch: vi.fn(async () => [makePair()]) } as unknown as DexScreenerClient,
    });

    await runDiscovery(deps, [FACTORY_A, FACTORY_B]);

    expect(tokenRepo.findByAddress("0xaaa")?.launch_block).toBe("12345");
  });
});
