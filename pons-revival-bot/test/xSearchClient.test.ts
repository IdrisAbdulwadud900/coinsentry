import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { XSearchClient } from "../src/data/xSearchClient.js";

const logger = pino({ level: "silent" });
const CA = "0x759d161b0d2f51a0b080687a1008166e12e6cbb8";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("XSearchClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports itself unconfigured without a token, and never calls the API", async () => {
    const fetchMock = stubFetch(200, {});
    const client = new XSearchClient(logger, "");

    expect(client.configured).toBe(false);
    expect(await client.findMentions(CA)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the accounts that posted the address, most-followed first", async () => {
    stubFetch(200, {
      data: [
        { id: "1", author_id: "u1" },
        { id: "2", author_id: "u2" },
      ],
      includes: {
        users: [
          { id: "u1", username: "small_acct", public_metrics: { followers_count: 120 } },
          { id: "u2", username: "big_acct", public_metrics: { followers_count: 90_000 } },
        ],
      },
    });

    const mentions = await new XSearchClient(logger, "token").findMentions(CA);

    expect(mentions?.map((m) => m.username)).toEqual(["big_acct", "small_acct"]);
    expect(mentions?.[0]?.followers).toBe(90_000);
    expect(mentions?.[0]?.tweetUrl).toBe("https://x.com/big_acct/status/2");
  });

  it("counts one account once even when it posted the address repeatedly", async () => {
    stubFetch(200, {
      data: [
        { id: "1", author_id: "u1" },
        { id: "2", author_id: "u1" },
        { id: "3", author_id: "u1" },
      ],
      includes: { users: [{ id: "u1", username: "spammer", public_metrics: { followers_count: 10 } }] },
    });

    const mentions = await new XSearchClient(logger, "token").findMentions(CA);

    // Three posts from one account is one account talking, not three.
    expect(mentions).toHaveLength(1);
  });

  it("distinguishes 'nobody posted it' from 'the lookup failed'", async () => {
    stubFetch(200, { data: [], includes: { users: [] } });
    await expect(new XSearchClient(logger, "token").findMentions(CA)).resolves.toEqual([]);

    stubFetch(429, { title: "Too Many Requests" });
    // Null, not [] — an alert must not imply nobody is talking about a coin when the truth
    // is that we were rate-limited and could not look.
    await expect(new XSearchClient(logger, "token").findMentions(CA)).resolves.toBeNull();
  });

  it("excludes retweets so one viral post does not look like a crowd", async () => {
    const fetchMock = stubFetch(200, { data: [], includes: { users: [] } });
    await new XSearchClient(logger, "token").findMentions(CA);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(decodeURIComponent(url)).toContain("-is:retweet");
    expect(decodeURIComponent(url)).toContain(CA);
  });

  it("survives a network error without throwing into the alert path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(new XSearchClient(logger, "token").findMentions(CA)).resolves.toBeNull();
  });
});
