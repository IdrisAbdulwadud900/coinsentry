import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { BlockscoutClient, computeHolderConcentration, type HolderEntry } from "../src/data/blockscoutClient.js";

const logger = pino({ level: "silent" });
const BASE_URL = "https://robinhoodchain.blockscout.com";

function mockFetchSequence(responses: { ok: boolean; status?: number; json?: () => Promise<unknown> }[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response as Response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlockscoutClient.fetchHolders", () => {
  it("returns null when the first request fails", async () => {
    mockFetchSequence([{ ok: false, status: 404 }]);
    const client = new BlockscoutClient(logger, BASE_URL);
    expect(await client.fetchHolders("0xtoken")).toBeNull();
  });

  it("returns a single page of holders when there's no next_page_params", async () => {
    mockFetchSequence([
      {
        ok: true,
        json: async () => ({
          items: [
            { address: { hash: "0xAAA" }, value: "1000" },
            { address: { hash: "0xBBB" }, value: "500" },
          ],
          next_page_params: null,
        }),
      },
    ]);
    const client = new BlockscoutClient(logger, BASE_URL);
    const holders = await client.fetchHolders("0xtoken");
    expect(holders).toEqual([
      { address: "0xaaa", value: 1000n },
      { address: "0xbbb", value: 500n },
    ]);
  });

  it("paginates via next_page_params until exhausted or maxHolders is reached", async () => {
    const fetchMock = mockFetchSequence([
      {
        ok: true,
        json: async () => ({
          items: [{ address: { hash: "0xAAA" }, value: "1000" }],
          next_page_params: { value: "1000", address_hash: "0xAAA", items_count: 50 },
        }),
      },
      {
        ok: true,
        json: async () => ({
          items: [{ address: { hash: "0xBBB" }, value: "500" }],
          next_page_params: null,
        }),
      },
    ]);
    const client = new BlockscoutClient(logger, BASE_URL);
    const holders = await client.fetchHolders("0xtoken");
    expect(holders).toEqual([
      { address: "0xaaa", value: 1000n },
      { address: "0xbbb", value: 500n },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallUrl = fetchMock.mock.calls[1]![0] as URL;
    expect(secondCallUrl.searchParams.get("value")).toBe("1000");
    expect(secondCallUrl.searchParams.get("address_hash")).toBe("0xAAA");
  });

  it("returns whatever was fetched so far when a later page fails", async () => {
    mockFetchSequence([
      {
        ok: true,
        json: async () => ({
          items: [{ address: { hash: "0xAAA" }, value: "1000" }],
          next_page_params: { value: "1000", address_hash: "0xAAA", items_count: 50 },
        }),
      },
      { ok: false, status: 500 },
    ]);
    const client = new BlockscoutClient(logger, BASE_URL);
    const holders = await client.fetchHolders("0xtoken");
    expect(holders).toEqual([{ address: "0xaaa", value: 1000n }]);
  });

  it("returns null when the fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network error");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BlockscoutClient(logger, BASE_URL);
    expect(await client.fetchHolders("0xtoken")).toBeNull();
  });
});

describe("computeHolderConcentration", () => {
  const holders: HolderEntry[] = [
    { address: "0xpool", value: 5000n },
    { address: "0xwhale1", value: 3000n },
    { address: "0xwhale2", value: 1000n },
    { address: "0xsmall", value: 500n },
    { address: "0x0000000000000000000000000000000000000000", value: 500n },
  ];

  it("returns null when total supply is zero or negative", () => {
    expect(computeHolderConcentration(holders, [], 0n)).toBeNull();
    expect(computeHolderConcentration(holders, [], -1n)).toBeNull();
  });

  it("excludes the pool/token-contract addresses and the burn address, then ranks the rest", () => {
    const result = computeHolderConcentration(holders, ["0xPool", "0xTokenContract"], 10000n);
    expect(result).not.toBeNull();
    expect(result!.topHolders.map((h) => h.address)).toEqual(["0xwhale1", "0xwhale2", "0xsmall"]);
    expect(result!.topHolders[0]!.pct).toBeCloseTo(30);
    expect(result!.top10Pct).toBeCloseTo(45); // (3000+1000+500)/10000
  });

  it("returns null when no real holders remain after exclusion", () => {
    const onlyPoolAndBurn: HolderEntry[] = [
      { address: "0xpool", value: 5000n },
      { address: "0x0000000000000000000000000000000000000000", value: 500n },
    ];
    expect(computeHolderConcentration(onlyPoolAndBurn, ["0xpool"], 10000n)).toBeNull();
  });

  it("ignores null entries in the exclude list", () => {
    const result = computeHolderConcentration(holders, [null, "0xpool"], 10000n);
    expect(result).not.toBeNull();
    expect(result!.topHolders.some((h) => h.address === "0xpool")).toBe(false);
  });
});
