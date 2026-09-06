import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { StonkfunClient } from "../src/data/stonkfunClient.js";

const logger = pino({ level: "silent" });
const API = "https://stonkfun.example/api/public/v1";

function stub(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("StonkfunClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the ledger into launches, preserving Solana address casing", async () => {
    // Base58 is case-sensitive: lower-casing a mint makes it a different, non-existent
    // address, which is why this is asserted rather than assumed.
    const MINT = "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx";
    stub(200, {
      data: {
        launches: [
          {
            mint: MINT,
            pool: "7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49",
            name: "Stonk",
            symbol: "STONK",
            createdAt: "2026-09-06T08:08:29.822Z",
            startMarketCapUsd: 2943,
          },
        ],
      },
    });

    const launches = await new StonkfunClient(logger, API).fetchLaunches();

    expect(launches).toHaveLength(1);
    expect(launches![0]!.mint).toBe(MINT);
    expect(launches![0]!.symbol).toBe("STONK");
    expect(launches![0]!.createdAt).toBe(Date.parse("2026-09-06T08:08:29.822Z"));
    expect(launches![0]!.startMarketCapUsd).toBe(2943);
  });

  it("requests the page it was asked for", async () => {
    const fetchMock = stub(200, { data: { launches: [] } });

    await new StonkfunClient(logger, API).fetchLaunches(4);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/launches?page=4");
  });

  it("skips entries with no mint rather than inventing one", async () => {
    stub(200, { data: { launches: [{ symbol: "BROKEN" }, { mint: "GoodMint", symbol: "OK" }] } });

    const launches = await new StonkfunClient(logger, API).fetchLaunches();

    expect(launches!.map((l) => l.symbol)).toEqual(["OK"]);
  });

  it("distinguishes a failed request from an empty ledger", async () => {
    stub(200, { data: { launches: [] } });
    await expect(new StonkfunClient(logger, API).fetchLaunches()).resolves.toEqual([]);

    // null, not [] — treating an outage as "nothing launched" would stop discovery silently.
    stub(503, { error: "unavailable" });
    await expect(new StonkfunClient(logger, API).fetchLaunches()).resolves.toBeNull();

    stub(200, { unexpected: "shape" });
    await expect(new StonkfunClient(logger, API).fetchLaunches()).resolves.toBeNull();
  });

  it("survives a network error without throwing into the poll cycle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(new StonkfunClient(logger, API).fetchLaunches()).resolves.toBeNull();
  });

  it("tolerates a missing or unparseable createdAt", async () => {
    stub(200, { data: { launches: [{ mint: "M1", symbol: "A", createdAt: "not-a-date" }, { mint: "M2", symbol: "B" }] } });

    const launches = await new StonkfunClient(logger, API).fetchLaunches();

    expect(launches!.map((l) => l.createdAt)).toEqual([null, null]);
  });
});
