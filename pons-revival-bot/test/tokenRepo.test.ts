import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { SnapshotRepo } from "../src/data/snapshotRepo.js";

describe("TokenRepo round-robin market scan", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);
  });

  it("serves never-checked tokens first, then oldest-checked, so nothing starves", () => {
    const now = Date.now();
    for (const suffix of ["a", "b", "c"]) {
      repo.insertIfNew(`0xAAA${suffix}`, "T", "T", "0xp", "active", null, "0xF1", now);
    }

    // First slice: all three are unchecked, take two of them.
    const first = repo.listTrackableForCycle(2);
    expect(first).toHaveLength(2);
    repo.markMarketChecked(
      first.map((t) => t.address),
      now
    );

    // Second slice must serve the remaining never-checked token first.
    const firstAddrs = new Set(first.map((t) => t.address));
    const second = repo.listTrackableForCycle(2);
    expect(second[0] && firstAddrs.has(second[0].address)).toBe(false);
    repo.markMarketChecked(
      second.map((t) => t.address),
      now + 1000
    );

    // Every token has now been covered across consecutive slices.
    expect(repo.listTrackable().every((t) => t.market_checked_at != null)).toBe(true);
  });

  it("always serves dead/alerted revival candidates before actives, even freshly-checked ones", () => {
    const now = Date.now();
    repo.insertIfNew("0xACC", "T", "T", "0xp", "active", null, "0xF1", now);
    repo.insertIfNew("0xDEAD", "T", "T", "0xp", "dead", null, "0xF1", now);
    repo.insertIfNew("0xA1E", "T", "T", "0xp", "alerted", null, "0xF1", now);

    // Mark the dead + alerted tokens as just-checked; they must STILL come first, since
    // revival detection depends on re-checking them every cycle.
    repo.markMarketChecked(["0xdead", "0xa1e"], now);

    const slice = repo.listTrackableForCycle(3);
    expect(
      slice
        .slice(0, 2)
        .map((t) => t.address)
        .sort()
    ).toEqual(["0xa1e", "0xdead"]);
    expect(slice[2]?.address).toBe("0xacc");
  });

  it("excludes 'unindexed' tokens from the cycle scan", () => {
    const now = Date.now();
    repo.insertIfNew("0xAAA", "T", "T", "0xp", "active", null, "0xF1", now);
    repo.insertIfNew("0xBBB", "T", "T", "", "unindexed", null, "0xF1", now);

    const slice = repo.listTrackableForCycle(10);
    expect(slice).toHaveLength(1);
    expect(slice[0]?.address).toBe("0xaaa");
  });
});

describe("TokenRepo.search / countRevivingCandidates", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);

    const now = Date.now();
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", now);
    repo.insertIfNew("0xBBB", "BAR", "Bar Token", "0xpairBBB", "dead", null, "0xFactory1", now - 1000);
    repo.insertIfNew("0xCCC", "BAZ", "Baz Token", "0xpairCCC", "dead", null, "0xFactory1", now - 2000);
    repo.insertIfNew("0xDDD", "QUX", "Qux Token", "0xpairDDD", "unindexed", null, "0xFactory1", now - 3000);

    // Give 0xCCC a nonzero revival_confirm_count so it's a "reviving candidate".
    repo.setRevivalConfirmCount("0xccc", 1);
  });

  it("countRevivingCandidates counts only dead tokens with revival_confirm_count > 0", () => {
    expect(repo.countRevivingCandidates()).toBe(1);
  });

  it("search filters by status", () => {
    const { rows, total } = repo.search({ status: "dead", limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.address).sort()).toEqual(["0xbbb", "0xccc"]);
  });

  it("search filters by revivingOnly", () => {
    const { rows, total } = repo.search({ revivingOnly: true, limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]?.address).toBe("0xccc");
  });

  it("search filters by symbol substring, case-insensitively via LIKE", () => {
    const { rows, total } = repo.search({ search: "ba", limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.symbol).sort()).toEqual(["BAR", "BAZ"]);
  });

  it("search filters by address substring", () => {
    const { rows, total } = repo.search({ search: "ccc", limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]?.address).toBe("0xccc");
  });

  it("search paginates with limit/offset while total reflects the full filtered set", () => {
    const page1 = repo.search({ limit: 2, offset: 0 });
    const page2 = repo.search({ limit: 2, offset: 2 });
    expect(page1.total).toBe(4);
    expect(page1.rows.length).toBe(2);
    expect(page2.rows.length).toBe(2);
  });

  it("search sorts by symbol when requested", () => {
    const { rows } = repo.search({ sort: "symbol", limit: 10, offset: 0 });
    expect(rows.map((r) => r.symbol)).toEqual(["BAR", "BAZ", "FOO", "QUX"]);
  });

  it("search filters by graduated", () => {
    repo.markGraduated("0xaaa", "1000", "2000", Date.now());
    const graduated = repo.search({ graduated: true, limit: 10, offset: 0 });
    expect(graduated.total).toBe(1);
    expect(graduated.rows[0]?.address).toBe("0xaaa");

    const ungraduated = repo.search({ graduated: false, limit: 10, offset: 0 });
    expect(ungraduated.total).toBe(3);
  });
});

describe("TokenRepo graduation tracking", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);

    const now = Date.now();
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", now);
    repo.insertIfNew("0xBBB", "BAR", "Bar Token", "0xpairBBB", "dead", null, "0xFactory1", now);
    // Unindexed tokens are excluded from the graduation sweep regardless of factory.
    repo.insertIfNew("0xCCC", "BAZ", "Baz Token", "0xpairCCC", "unindexed", null, "0xFactory1", now);
    // No factory address on record (e.g. legacy row) — also excluded.
    repo.insertIfNew("0xDDD", "QUX", "Qux Token", "0xpairDDD", "active", null, null, now);
  });

  it("listUngraduatedTrackable excludes unindexed, no-factory, and already-graduated tokens", () => {
    const due = repo.listUngraduatedTrackable();
    expect(due.map((t) => t.address).sort()).toEqual(["0xaaa", "0xbbb"]);
  });

  it("markGraduated sets graduated=1 permanently and stores the paired/threshold amounts", () => {
    const now = Date.now();
    repo.markGraduated("0xaaa", "4200000000000000000", "4200000000000000000", now);
    const token = repo.findByAddress("0xaaa");
    expect(token?.graduated).toBe(1);
    expect(token?.graduation_paired_wei).toBe("4200000000000000000");
    expect(token?.graduation_threshold_wei).toBe("4200000000000000000");
    expect(token?.graduation_checked_at).toBe(now);

    const due = repo.listUngraduatedTrackable();
    expect(due.map((t) => t.address)).not.toContain("0xaaa");
  });

  it("updateGraduationProgress refreshes progress without setting graduated", () => {
    const now = Date.now();
    repo.updateGraduationProgress("0xaaa", "1000000000000000000", "4200000000000000000", now);
    const token = repo.findByAddress("0xaaa");
    expect(token?.graduated).toBe(0);
    expect(token?.graduation_paired_wei).toBe("1000000000000000000");
    expect(token?.graduation_threshold_wei).toBe("4200000000000000000");

    const due = repo.listUngraduatedTrackable();
    expect(due.map((t) => t.address)).toContain("0xaaa");
  });

  it("countByGraduation reflects graduated vs. ungraduated counts across all tokens", () => {
    repo.markGraduated("0xaaa", "1", "1", Date.now());
    const counts = repo.countByGraduation();
    expect(counts.graduated).toBe(1);
    expect(counts.ungraduated).toBe(3);
  });

  it("listUngraduatedRecentlyLaunched includes unindexed tokens (unlike listUngraduatedTrackable)", () => {
    const due = repo.listUngraduatedRecentlyLaunched(0);
    // 0xDDD is excluded (no factory_address); 0xCCC ('unindexed') is included here.
    expect(due.map((t) => t.address).sort()).toEqual(["0xaaa", "0xbbb", "0xccc"]);
  });

  it("listUngraduatedRecentlyLaunched respects the recency cutoff", () => {
    const now = Date.now();
    repo.insertIfNew("0xEEE", "OLD", "Old Token", "0xpairEEE", "active", null, "0xFactory1", now - 1_000_000);
    const due = repo.listUngraduatedRecentlyLaunched(now - 500_000);
    expect(due.map((t) => t.address)).not.toContain("0xeee");
  });

  it("listUngraduatedRecentlyLaunched excludes already-graduated tokens", () => {
    repo.markGraduated("0xaaa", "1", "1", Date.now());
    const due = repo.listUngraduatedRecentlyLaunched(0);
    expect(due.map((t) => t.address)).not.toContain("0xaaa");
  });
});

describe("TokenRepo momentum tracking", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);

    const now = Date.now();
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", now);
    repo.insertIfNew("0xBBB", "BAR", "Bar Token", "0xpairBBB", "alerted", null, "0xFactory1", now);
    repo.insertIfNew("0xCCC", "BAZ", "Baz Token", "0xpairCCC", "unindexed", null, "0xFactory1", now);
  });

  it("listRecentlyLaunchedActive excludes unindexed tokens", () => {
    const due = repo.listRecentlyLaunchedActive(0);
    expect(due.map((t) => t.address).sort()).toEqual(["0xaaa", "0xbbb"]);
  });

  it("listRecentlyLaunchedActive excludes tokens once momentum_alert_count reaches the cap", () => {
    repo.incrementMomentumAlertCount("0xaaa");
    repo.incrementMomentumAlertCount("0xaaa");
    const due = repo.listRecentlyLaunchedActive(0);
    expect(due.map((t) => t.address)).toEqual(["0xbbb"]);
  });

  it("listRecentlyLaunchedActive still includes a token after just one momentum alert (eligible for re-alert)", () => {
    repo.incrementMomentumAlertCount("0xaaa");
    const due = repo.listRecentlyLaunchedActive(0);
    expect(due.map((t) => t.address).sort()).toEqual(["0xaaa", "0xbbb"]);
  });

  it("listRecentlyLaunchedActive respects the recency cutoff", () => {
    const now = Date.now();
    repo.insertIfNew("0xDDD", "OLD", "Old Token", "0xpairDDD", "active", null, "0xFactory1", now - 1_000_000);
    const due = repo.listRecentlyLaunchedActive(now - 500_000);
    expect(due.map((t) => t.address)).not.toContain("0xddd");
  });
});

describe("TokenRepo.setGraduationAlertTier", () => {
  it("persists the highest already-alerted tier index", () => {
    const db = openDatabase(":memory:");
    const repo = new TokenRepo(db);
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", Date.now());

    expect(repo.findByAddress("0xaaa")?.graduation_alert_tier).toBe(0);
    repo.setGraduationAlertTier("0xaaa", 3);
    expect(repo.findByAddress("0xaaa")?.graduation_alert_tier).toBe(3);
  });
});

describe("TokenRepo performance tracking", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", Date.now());
  });

  it("setImageUrlIfMissing caches the image once and never overwrites it", () => {
    expect(repo.findByAddress("0xaaa")?.image_url).toBeNull();

    repo.setImageUrlIfMissing("0xaaa", "https://example.com/first.png");
    expect(repo.findByAddress("0xaaa")?.image_url).toBe("https://example.com/first.png");

    repo.setImageUrlIfMissing("0xaaa", "https://example.com/second.png");
    expect(repo.findByAddress("0xaaa")?.image_url).toBe("https://example.com/first.png");
  });

  it("setFirstAlertMarketCap sets the baseline once and never overwrites it", () => {
    const now = Date.now();
    repo.setFirstAlertMarketCap("0xaaa", 1000, now);
    let token = repo.findByAddress("0xaaa");
    expect(token?.first_alert_market_cap_usd).toBe(1000);
    expect(token?.first_alert_at).toBe(now);

    repo.setFirstAlertMarketCap("0xaaa", 5000, now + 1000);
    token = repo.findByAddress("0xaaa");
    expect(token?.first_alert_market_cap_usd).toBe(1000);
    expect(token?.first_alert_at).toBe(now);
  });

  it("updatePeakMultiple only updates when the new value is higher", () => {
    const now = Date.now();
    repo.updatePeakMultiple("0xaaa", 2, now);
    expect(repo.findByAddress("0xaaa")?.peak_multiple).toBe(2);

    repo.updatePeakMultiple("0xaaa", 1.5, now + 1000);
    expect(repo.findByAddress("0xaaa")?.peak_multiple).toBe(2);

    repo.updatePeakMultiple("0xaaa", 3, now + 2000);
    const token = repo.findByAddress("0xaaa");
    expect(token?.peak_multiple).toBe(3);
    expect(token?.peak_multiple_at).toBe(now + 2000);
  });

  it("setLastMilestoneMultipleAlerted stores the highest crossed milestone", () => {
    repo.setLastMilestoneMultipleAlerted("0xaaa", 5);
    expect(repo.findByAddress("0xaaa")?.last_milestone_multiple_alerted).toBe(5);
    repo.setLastMilestoneMultipleAlerted("0xaaa", 10);
    expect(repo.findByAddress("0xaaa")?.last_milestone_multiple_alerted).toBe(10);
  });

  it("listTopByPeakMultiple returns only tokens with a peak_multiple, sorted descending", () => {
    repo.insertIfNew("0xBBB", "BAR", "Bar Token", "0xpairBBB", "active", null, "0xFactory1", Date.now());
    repo.insertIfNew("0xCCC", "BAZ", "Baz Token", "0xpairCCC", "active", null, "0xFactory1", Date.now());
    const now = Date.now();
    repo.updatePeakMultiple("0xaaa", 2, now);
    repo.updatePeakMultiple("0xbbb", 8, now);
    // 0xccc has no peak_multiple set (defaults to 0) and should be excluded.

    const top = repo.listTopByPeakMultiple(10);
    expect(top.map((t) => t.address)).toEqual(["0xbbb", "0xaaa"]);
  });
});

describe("TokenRepo.updateIdentity", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);
  });

  it("repairs a placeholder symbol/name once real data is available", () => {
    repo.insertIfNew("0xAAA", "?", "Unknown", "0xpairAAA", "active", null, "0xFactory1", Date.now());
    repo.updateIdentity("0xAAA", "FOO", "Foo Token");
    const token = repo.findByAddress("0xaaa");
    expect(token?.symbol).toBe("FOO");
    expect(token?.name).toBe("Foo Token");
  });

  it("never overwrites an already-real identity", () => {
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", Date.now());
    repo.updateIdentity("0xAAA", "DIFFERENT", "Different Token");
    const token = repo.findByAddress("0xaaa");
    expect(token?.symbol).toBe("FOO");
    expect(token?.name).toBe("Foo Token");
  });

  it("is a no-op when either the incoming symbol or name is still a placeholder", () => {
    repo.insertIfNew("0xAAA", "?", "Unknown", "0xpairAAA", "active", null, "0xFactory1", Date.now());

    repo.updateIdentity("0xAAA", "?", "Some Name");
    expect(repo.findByAddress("0xaaa")?.symbol).toBe("?");
    expect(repo.findByAddress("0xaaa")?.name).toBe("Unknown");

    repo.updateIdentity("0xAAA", "SYM", "Unknown");
    expect(repo.findByAddress("0xaaa")?.symbol).toBe("?");
    expect(repo.findByAddress("0xaaa")?.name).toBe("Unknown");
  });
});

describe("TokenRepo.insertIfNew launch_block", () => {
  let db: Db;
  let repo: TokenRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new TokenRepo(db);
  });

  it("persists the launch block when provided", () => {
    repo.insertIfNew(
      "0xAAA",
      "FOO",
      "Foo Token",
      "0xpairAAA",
      "active",
      null,
      "0xFactory1",
      Date.now(),
      "0xpool",
      "0xpairtoken",
      "123456"
    );
    expect(repo.findByAddress("0xaaa")?.launch_block).toBe("123456");
  });

  it("defaults launch_block to null when omitted (legacy call sites)", () => {
    repo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xFactory1", Date.now());
    expect(repo.findByAddress("0xaaa")?.launch_block).toBeNull();
  });
});

describe("listTrackableForCycle prioritises coins that are actually trading", () => {
  // Even round-robin ordering was the largest cause of missed moves in production: with
  // ~57,000 trackable coins and only ~1,465 scanned per hour, any given coin waited ~40
  // hours for its turn — while just ~1,300 coins had traded at all in the last day. A
  // surge lasting an hour cannot be seen by a scan that comes round every 40.
  it("puts a recently-trading coin ahead of a long-idle one that is more overdue", () => {
    const db = openDatabase(":memory:");
    const tokenRepo = new TokenRepo(db);
    const snapshotRepo = new SnapshotRepo(db);
    const now = Date.now();

    // IDLE is far more overdue by the old ordering, so it would have gone first.
    tokenRepo.insertIfNew("0x1d1e0000000000000000000000000000000000aa", "IDLE", "Idle", "0xp1", "active", null, null, now - 86400000);
    tokenRepo.insertIfNew("0xb0770000000000000000000000000000000000bb", "HOT", "Hot", "0xp2", "active", null, null, now - 86400000);
    tokenRepo.markMarketChecked(["0x1d1e0000000000000000000000000000000000aa"], now - 40 * 3600000);
    tokenRepo.markMarketChecked(["0xb0770000000000000000000000000000000000bb"], now - 60000);

    snapshotRepo.insert(
      {
        tokenAddress: "0xb0770000000000000000000000000000000000bb", symbol: "HOT", name: "Hot", priceUsd: 0.01, marketCapUsd: 9000,
        liquidityUsd: 4000, volume5m: 10, volume1h: 800, volume24h: 5000, buys5m: 2, buys1h: 9,
        sells1h: 3, imageUrl: null, websiteUrl: null, socials: [], dexUrl: "", pairCreatedAt: null,
      },
      now - 60000
    );

    const order = tokenRepo.listTrackableForCycle(10).map((t) => t.address);
    expect(order[0]).toBe("0xb0770000000000000000000000000000000000bb");
  });
});
