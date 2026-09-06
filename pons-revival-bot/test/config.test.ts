import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Loads config fresh with a given env, since the schema is applied at import time. */
async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  const prev = { ...process.env };
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "1",
    PONS_FACTORY_ACTIVE: "0xA",
    PONS_FACTORY_ACTIVE_START_BLOCK: "1",
    PONS_FACTORY_LEGACY: "0xB",
    PONS_FACTORY_LEGACY_START_BLOCK: "1",
    ...env,
  });
  try {
    const { loadConfig } = await import("../src/config.js");
    return loadConfig();
  } finally {
    process.env = prev;
  }
}

describe("SOLANA_RPC_URL resilience", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("accepts a valid endpoint", async () => {
    const cfg = await loadWith({ SOLANA_RPC_URL: "https://solana-mainnet.core.chainstack.com/abc123" });
    expect(cfg.SOLANA_RPC_URL).toBe("https://solana-mainnet.core.chainstack.com/abc123");
  });

  it("repairs a URL broken across lines when pasted", async () => {
    // Exactly how it failed in production: the terminal wrapped the endpoint and the
    // secret was stored containing a newline.
    const cfg = await loadWith({ SOLANA_RPC_URL: "https://solana-mainnet.core\n.chainstack.com/abc123" });
    expect(cfg.SOLANA_RPC_URL).toBe("https://solana-mainnet.core.chainstack.com/abc123");
  });

  it("falls back rather than aborting startup on an unusable value", async () => {
    // This previously threw at load and crash-looped the whole bot until the secret was
    // removed. A bad optional endpoint must never cost more than Solana safety checks.
    const cfg = await loadWith({ SOLANA_RPC_URL: "not a url at all" });
    expect(cfg.SOLANA_RPC_URL).toBe("https://api.mainnet-beta.solana.com");
    expect(console.warn).toHaveBeenCalled();
  });

  it("refuses a non-http scheme rather than handing it to fetch", async () => {
    const cfg = await loadWith({ SOLANA_RPC_URL: "ftp://example.com/rpc" });
    expect(cfg.SOLANA_RPC_URL).toBe("https://api.mainnet-beta.solana.com");
  });
});
