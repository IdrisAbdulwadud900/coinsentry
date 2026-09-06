import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { runSolanaDiscovery } from "../src/data/solanaDiscovery.js";
import type { JupiterClient, JupiterRecentToken } from "../src/data/jupiterClient.js";

const logger = pino({ level: "silent" });
const MINT = "CvU3MaCrCdEN1QjYbHNEy5y6vVpmRxVENSxWbeRHpump";

function token(overrides: Partial<JupiterRecentToken> = {}): JupiterRecentToken {
  return {
    address: MINT,
    symbol: "MOON",
    name: "Moon Coin",
    decimals: 6,
    iconUrl: "https://ipfs.example/moon.png",
    dev: "AMGiHGRG6Qv3aV9ixxqHNUmzrnxpxG9C2SJzgMYN3KP",
    launchpad: "pump.fun",
    marketCapUsd: 2091,
    liquidityUsd: 2235,
    totalSupply: 1_000_000_000,
    firstPoolCreatedAt: Date.now() - 6000,
    devMints: 3,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    ...overrides,
  };
}

describe("runSolanaDiscovery", () => {
  let db: Db;
  let tokenRepo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tokenRepo = new TokenRepo(db);
  });

  function deps(tokens: JupiterRecentToken[]) {
    return {
      tokenRepo,
      jupiter: { fetchRecentTokens: vi.fn(async () => tokens) } as unknown as JupiterClient,
      minLiquidityUsd: 200,
      spamDevMintsThreshold: 50,
      logger,
    };
  }

  it("tracks a seconds-old Solana token at its real birth time and market cap", async () => {
    const born = Date.now() - 6000;
    const inserted = await runSolanaDiscovery(deps([token({ firstPoolCreatedAt: born })]));

    expect(inserted).toBe(1);
    const t = tokenRepo.findByAddress(MINT);
    expect(t?.address).toBe(MINT); // case-sensitive base58 preserved
    expect(t?.chain).toBe("solana");
    expect(t?.symbol).toBe("MOON");
    expect(t?.status).toBe("active");
    expect(t?.first_seen_at).toBe(born);
    expect(t?.image_url).toBe("https://ipfs.example/moon.png");
  });

  it("records the deployer and raw total supply so holder math works later", async () => {
    await runSolanaDiscovery(deps([token()]));

    const t = tokenRepo.findByAddress(MINT);
    expect(t?.deployer_address).toBe("AMGiHGRG6Qv3aV9ixxqHNUmzrnxpxG9C2SJzgMYN3KP");
    // 1e9 human units at 6 decimals -> 1e15 raw units.
    expect(t?.token_total_supply).toBe("1000000000000000");
  });

  it("parks a mass-minting spam farm's token as unindexed instead of scanning it", async () => {
    await runSolanaDiscovery(deps([token({ devMints: 592 })]));

    expect(tokenRepo.findByAddress(MINT)?.status).toBe("unindexed");
  });

  it("parks a token below the liquidity floor as unindexed", async () => {
    await runSolanaDiscovery(deps([token({ liquidityUsd: 10 })]));

    expect(tokenRepo.findByAddress(MINT)?.status).toBe("unindexed");
  });

  it("never re-inserts a token it already tracks", async () => {
    const d = deps([token()]);
    await runSolanaDiscovery(d);

    expect(await runSolanaDiscovery(d)).toBe(0);
  });

  it("returns zero without throwing when the feed is empty or unavailable", async () => {
    expect(await runSolanaDiscovery(deps([]))).toBe(0);
  });
});

describe("launchpad attribution", () => {
  // Passing null for factory_address meant every Solana coin discovered was then excluded
  // by the launchpad-only scan filter — discovery ran and nothing ever came of it.
  function jupToken(over: Record<string, unknown> = {}) {
    return {
      address: "So11111111111111111111111111111111111111112",
      symbol: "TKN",
      name: "Token",
      dev: "Dev111",
      launchpad: "raydium-launchlab",
      liquidityUsd: 5000,
      devMints: 1,
      firstPoolCreatedAt: Date.now(),
      ...over,
    };
  }

  it("records the launchpad so the coin survives the launchpad-only scan filter", async () => {
    const db = openDatabase(":memory:");
    const tokenRepo = new TokenRepo(db);
    await runSolanaDiscovery({
      tokenRepo,
      jupiter: { fetchRecentTokens: async () => [jupToken()] } as never,
      minLiquidityUsd: 200,
      spamDevMintsThreshold: 50,
      logger,
    });

    const row = tokenRepo.findByAddress("So11111111111111111111111111111111111111112");
    expect(row?.factory_address).toBe("raydium-launchlab");
    expect(row?.chain).toBe("solana");
  });

  it("tracks only the launchpads asked for", async () => {
    const db = openDatabase(":memory:");
    const tokenRepo = new TokenRepo(db);
    await runSolanaDiscovery({
      tokenRepo,
      jupiter: {
        fetchRecentTokens: async () => [
          jupToken({ address: "Keep1", launchpad: "raydium-launchlab" }),
          jupToken({ address: "Drop1", launchpad: "some-other-pad" }),
          // Unknown provenance cannot be attributed to a launchpad the owner asked for.
          jupToken({ address: "Drop2", launchpad: null }),
        ],
      } as never,
      minLiquidityUsd: 200,
      spamDevMintsThreshold: 50,
      trackedLaunchpads: ["raydium-launchlab"],
      logger,
    });

    expect(tokenRepo.findByAddress("Keep1")).toBeDefined();
    expect(tokenRepo.findByAddress("Drop1")).toBeUndefined();
    expect(tokenRepo.findByAddress("Drop2")).toBeUndefined();
  });
});
