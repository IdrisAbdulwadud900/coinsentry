import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { EthPriceClient } from "../src/data/ethPrice.js";

const logger = pino({ level: "silent" });

function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EthPriceClient", () => {
  it("returns null before any successful fetch", async () => {
    mockFetchOnce({ ok: false, status: 500 });
    const client = new EthPriceClient(logger, 60_000);
    expect(await client.getUsdPrice()).toBeNull();
  });

  it("returns the fetched price on success", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ ethereum: { usd: 3500 } }) });
    const client = new EthPriceClient(logger, 60_000);
    expect(await client.getUsdPrice()).toBe(3500);
  });

  it("serves the cached price without refetching within the TTL", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ ethereum: { usd: 3500 } }) });
    const client = new EthPriceClient(logger, 60_000);
    await client.getUsdPrice();
    await client.getUsdPrice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully to the last known price when a later fetch fails", async () => {
    const client = new EthPriceClient(logger, 0); // TTL 0 so every call refetches
    mockFetchOnce({ ok: true, json: async () => ({ ethereum: { usd: 3500 } }) });
    expect(await client.getUsdPrice()).toBe(3500);

    mockFetchOnce({ ok: false, status: 503 });
    expect(await client.getUsdPrice()).toBe(3500);
  });

  it("treats a malformed response body as a failure and never fabricates a price", async () => {
    mockFetchOnce({ ok: true, json: async () => ({}) });
    const client = new EthPriceClient(logger, 60_000);
    expect(await client.getUsdPrice()).toBeNull();
  });
});
