import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { runMultiChainDiscovery } from "../src/data/multiChainDiscovery.js";
import { normalizeAddress, chainBadge, hasOnChainIntegrations, DEFAULT_CHAIN } from "../src/data/chains.js";
import type { DexScreenerClient } from "../src/data/dexscreener.js";
import { SolanaClient } from "../src/data/solanaClient.js";
import { JupiterClient } from "../src/data/jupiterClient.js";

const logger = pino({ level: "silent" });

// A real Solana address: base58, case-sensitive, must survive storage unmodified.
const SOL_ADDRESS = "Gezgjes2JwgHbQRuRMsZ9EuryJjhStcCgEToEQaXVmEP";

describe("chain helpers", () => {
  it("lowercases EVM addresses but leaves case-sensitive Solana addresses untouched", () => {
    expect(normalizeAddress("0xAbCdEf0123456789aBCdef0123456789AbCDef01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01"
    );
    expect(normalizeAddress(SOL_ADDRESS)).toBe(SOL_ADDRESS);
  });

  it("marks only Robinhood as having contract-level integrations", () => {
    expect(hasOnChainIntegrations("robinhood")).toBe(true);
    for (const chain of ["solana", "bsc", "ethereum", "unknown"]) {
      expect(hasOnChainIntegrations(chain)).toBe(false);
    }
  });

  it("renders a readable badge per chain and falls back to the raw id", () => {
    expect(chainBadge("solana")).toBe("◎ Solana");
    expect(chainBadge("bsc")).toBe("🟡 BSC");
    expect(chainBadge("ethereum")).toBe("Ξ Ethereum");
    expect(chainBadge("weirdchain")).toBe("weirdchain");
  });
});

describe("runMultiChainDiscovery", () => {
  let db: Db;
  let tokenRepo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tokenRepo = new TokenRepo(db);
  });

  function deps(overrides: { feed?: unknown[]; pairs?: unknown[] } = {}) {
    const dex = {
      fetchDiscoveryFeeds: vi.fn(async () => overrides.feed ?? []),
      lookupBatch: vi.fn(async () => overrides.pairs ?? []),
    } as unknown as DexScreenerClient;
    return {
      tokenRepo,
      dex,
      enabledChains: ["robinhood", "solana", "bsc", "ethereum"],
      minLiquidityUsd: 200,
      logger,
    };
  }

  function solPair(liquidityUsd: number, pairCreatedAt?: number) {
    return {
      chainId: "solana",
      dexId: "pumpswap",
      pairAddress: "7C19P9fpFSCvvmkSmw767ojHeq9y837vq4LGseBaX1zq",
      baseToken: { address: SOL_ADDRESS, symbol: "MOON", name: "Moon Coin" },
      liquidity: { usd: liquidityUsd },
      marketCap: 5796,
      pairCreatedAt,
      info: { imageUrl: "https://img.example/moon.png" },
    };
  }

  it("tracks a new Solana token with its address and chain preserved exactly", async () => {
    const d = deps({
      feed: [{ chainId: "solana", tokenAddress: SOL_ADDRESS, links: [{ type: "twitter", url: "https://x.com/m" }] }],
      pairs: [solPair(4190)],
    });

    const inserted = await runMultiChainDiscovery(d);

    expect(inserted).toBe(1);
    const token = tokenRepo.findByAddress(SOL_ADDRESS);
    expect(token?.address).toBe(SOL_ADDRESS); // NOT lowercased
    expect(token?.chain).toBe("solana");
    expect(token?.symbol).toBe("MOON");
    expect(token?.status).toBe("active");
    expect(token?.image_url).toBe("https://img.example/moon.png");
  });

  it("uses the pair's real creation time as first_seen_at so token age is accurate", async () => {
    const created = Date.now() - 42 * 60 * 1000;
    const d = deps({
      feed: [{ chainId: "solana", tokenAddress: SOL_ADDRESS, links: [] }],
      pairs: [solPair(4190, created)],
    });

    await runMultiChainDiscovery(d);

    expect(tokenRepo.findByAddress(SOL_ADDRESS)?.first_seen_at).toBe(created);
  });

  it("tracks a below-liquidity-floor token as unindexed rather than active", async () => {
    const d = deps({
      feed: [{ chainId: "solana", tokenAddress: SOL_ADDRESS, links: [] }],
      pairs: [solPair(50)],
    });

    await runMultiChainDiscovery(d);

    expect(tokenRepo.findByAddress(SOL_ADDRESS)?.status).toBe("unindexed");
  });

  it("ignores chains that are not enabled", async () => {
    const d = {
      ...deps({ feed: [{ chainId: "base", tokenAddress: "0xaaa", links: [] }] }),
      enabledChains: ["robinhood", "solana"],
    };

    expect(await runMultiChainDiscovery(d)).toBe(0);
    expect(tokenRepo.findByAddress("0xaaa")).toBeUndefined();
  });

  it("never re-resolves tokens it already tracks", async () => {
    const d = deps({
      feed: [{ chainId: "solana", tokenAddress: SOL_ADDRESS, links: [] }],
      pairs: [solPair(4190)],
    });
    await runMultiChainDiscovery(d);
    vi.mocked(d.dex.lookupBatch).mockClear();

    const second = await runMultiChainDiscovery(d);

    expect(second).toBe(0);
    expect(d.dex.lookupBatch).not.toHaveBeenCalled();
  });

  it("skips a cross-chain address collision instead of overwriting the tracked token", async () => {
    const shared = "0xabcdef0123456789abcdef0123456789abcdef01";
    tokenRepo.insertIfNew(shared, "ETHCOIN", "Eth Coin", "0xp", "active", null, null, Date.now(), null, null, null, "ethereum");

    const d = deps({
      feed: [{ chainId: "bsc", tokenAddress: shared, links: [] }],
      pairs: [],
    });
    await runMultiChainDiscovery(d);

    const token = tokenRepo.findByAddress(shared);
    expect(token?.chain).toBe("ethereum");
    expect(token?.symbol).toBe("ETHCOIN");
  });

  it("leaves Robinhood discovery to the on-chain factory scan", async () => {
    const d = deps({ feed: [{ chainId: DEFAULT_CHAIN, tokenAddress: "0xaaa", links: [] }] });

    expect(await runMultiChainDiscovery(d)).toBe(0);
    expect(tokenRepo.findByAddress("0xaaa")).toBeUndefined();
  });
});

describe("SolanaClient mint safety", () => {
  function clientWith(response: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(response), { status: ok ? 200 : 500 }))
    );
    return new SolanaClient(logger, "https://rpc.example");
  }

  function mintInfo(mintAuthority: string | null, freezeAuthority: string | null) {
    return { result: { value: { data: { parsed: { info: { mintAuthority, freezeAuthority, decimals: 6 } } } } } };
  }

  it("reports both authorities revoked when the mint reports nulls", async () => {
    const c = clientWith(mintInfo(null, null));
    try {
      expect(await c.fetchMintSafety(SOL_ADDRESS)).toEqual({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("flags an active freeze authority — the Solana honeypot vector", async () => {
    const c = clientWith(mintInfo(null, "FrEeZeAuTh1111111111111111111111111111111"));
    try {
      const safety = await c.fetchMintSafety(SOL_ADDRESS);
      expect(safety?.freezeAuthorityActive).toBe(true);
      expect(safety?.mintAuthorityActive).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null (never assumes safe) when the RPC errors or rate-limits", async () => {
    const c = clientWith({ error: { code: 429, message: "Too many requests" } });
    try {
      expect(await c.fetchMintSafety(SOL_ADDRESS)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null when the account isn't a parseable SPL mint", async () => {
    const c = clientWith({ result: { value: null } });
    try {
      expect(await c.fetchMintSafety(SOL_ADDRESS)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("JupiterClient.fetchTokenSafety", () => {
  function clientWith(body: unknown, ok = true) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })));
    return new JupiterClient(logger);
  }

  const hit = (audit: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
    { id: SOL_ADDRESS, holderCount: 1859, organicScoreLabel: "medium", audit, ...extra },
  ];

  it("returns concentration, holder count and rating for an exact mint match", async () => {
    const c = clientWith(
      hit({ mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 17.99 })
    );
    try {
      expect(await c.fetchTokenSafety(SOL_ADDRESS)).toEqual({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        topHoldersPct: 17.99,
        holderCount: 1859,
        organicScoreLabel: "medium",
        iconUrl: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("flags an active freeze authority", async () => {
    const c = clientWith(hit({ mintAuthorityDisabled: true, freezeAuthorityDisabled: false }));
    try {
      expect((await c.fetchTokenSafety(SOL_ADDRESS))?.freezeAuthorityActive).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores fuzzy search hits that are not the requested mint", async () => {
    const c = clientWith([{ id: "SomeOtherMint1111111111111111111111111111", audit: { freezeAuthorityDisabled: true } }]);
    try {
      expect(await c.fetchTokenSafety(SOL_ADDRESS)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null rather than implying safety when authority status is unknown", async () => {
    const c = clientWith(hit({ topHoldersPercentage: 20 }));
    try {
      expect(await c.fetchTokenSafety(SOL_ADDRESS)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
