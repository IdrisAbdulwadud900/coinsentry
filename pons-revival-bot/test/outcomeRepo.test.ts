import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Db } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { OutcomeRepo } from "../src/data/outcomeRepo.js";

const H1 = 60 * 60 * 1000;

describe("OutcomeRepo", () => {
  let db: Db;
  let tokenRepo: TokenRepo;
  let repo: OutcomeRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tokenRepo = new TokenRepo(db);
    repo = new OutcomeRepo(db);
    tokenRepo.insertIfNew("0xAAA", "FOO", "Foo Token", "0xpairAAA", "active", null, "0xF1", Date.now());
  });

  function entry(overrides: Partial<Parameters<OutcomeRepo["recordEntry"]>[0]> = {}) {
    return {
      address: "0xaaa",
      firstAlertedAt: Date.now(),
      alertType: "momentum",
      entryMarketCapUsd: 8000,
      bundleTop5Pct: 25,
      holderTop10Pct: 35,
      devSold: 0,
      hadWebsite: true,
      socialCount: 2,
      ...overrides,
    };
  }

  it("records the first alert's entry features and never overwrites them on later alerts", () => {
    repo.recordEntry(entry({ alertType: "momentum", entryMarketCapUsd: 8000 }));
    repo.recordEntry(entry({ alertType: "graduation", entryMarketCapUsd: 10_500 }));

    const row = repo.findByAddress("0xaaa");
    expect(row?.alert_type).toBe("momentum");
    expect(row?.entry_market_cap_usd).toBe(8000);
  });

  it("returns rows due for each elapsed, unfilled checkpoint and excludes fresh rows", () => {
    const now = Date.now();
    repo.recordEntry(entry({ firstAlertedAt: now - 2 * H1 })); // 1h checkpoint due
    expect(repo.listDueForCheckpoints(now)).toHaveLength(1);

    repo.applyCheckpoints("0xaaa", { mcap1hUsd: 9000 }, "pending", now);
    // 1h filled, 6h/24h not yet elapsed -> nothing due.
    expect(repo.listDueForCheckpoints(now)).toHaveLength(0);
  });

  it("excludes rows older than the retry ceiling so unresolvable rows aren't retried forever", () => {
    const now = Date.now();
    repo.recordEntry(entry({ firstAlertedAt: now - 8 * 24 * H1 }));
    expect(repo.listDueForCheckpoints(now)).toHaveLength(0);
  });

  it("applyCheckpoints updates only the provided checkpoints plus the outcome", () => {
    const now = Date.now();
    repo.recordEntry(entry({ firstAlertedAt: now - 7 * H1 }));
    repo.applyCheckpoints("0xaaa", { mcap1hUsd: 9000, mcap6hUsd: 4000 }, "pending", now);

    const row = repo.findByAddress("0xaaa");
    expect(row?.mcap_1h_usd).toBe(9000);
    expect(row?.mcap_6h_usd).toBe(4000);
    expect(row?.mcap_24h_usd).toBeNull();
    expect(row?.outcome).toBe("pending");
  });

  it("aggregates entry features per outcome for the insights report", () => {
    tokenRepo.insertIfNew("0xBBB", "BAR", "Bar Token", "0xpairBBB", "active", null, "0xF1", Date.now());
    repo.recordEntry(entry({ address: "0xaaa", bundleTop5Pct: 20 }));
    repo.recordEntry(entry({ address: "0xbbb", bundleTop5Pct: 40 }));
    repo.applyCheckpoints("0xaaa", {}, "winner", Date.now());
    repo.applyCheckpoints("0xbbb", {}, "dumper", Date.now());

    const stats = new Map(repo.featureStatsByOutcome().map((s) => [s.outcome, s]));
    expect(stats.get("winner")?.avgBundleTop5Pct).toBe(20);
    expect(stats.get("dumper")?.avgBundleTop5Pct).toBe(40);
    expect(repo.countByOutcome()).toEqual({ winner: 1, dumper: 1 });
  });

  it("reports resolved win/dump/flat counts per alert type and ignores pending rows", () => {
    tokenRepo.insertIfNew("0xBBB", "BAR", "Bar", "0xp", "active", null, "0xF1", Date.now());
    tokenRepo.insertIfNew("0xCCC", "BAZ", "Baz", "0xp", "active", null, "0xF1", Date.now());
    repo.recordEntry(entry({ address: "0xaaa", alertType: "momentum" }));
    repo.recordEntry(entry({ address: "0xbbb", alertType: "momentum" }));
    repo.recordEntry(entry({ address: "0xccc", alertType: "revival" }));
    repo.applyCheckpoints("0xaaa", {}, "winner", Date.now());
    repo.applyCheckpoints("0xbbb", {}, "dumper", Date.now());
    // 0xccc stays pending and must be excluded entirely.

    const byType = new Map(repo.outcomeCountsByAlertType().map((t) => [t.alertType, t]));
    expect(byType.get("momentum")).toMatchObject({ winners: 1, dumpers: 1, flat: 0 });
    expect(byType.has("revival")).toBe(false);
  });

  it("upserts missed winners: ATH only rises, first detection time kept, known reason wins", () => {
    const t0 = Date.now();
    repo.upsertMissedWinner("0xaaa", "FOO", t0, 30_000, null);
    repo.upsertMissedWinner("0xaaa", "FOO", t0 + 1000, 50_000, "no website or social links");
    repo.upsertMissedWinner("0xaaa", "FOO", t0 + 2000, 20_000, null); // lower ATH, unknown reason

    const rows = repo.listMissedWinners(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ath_market_cap_usd).toBe(50_000);
    expect(rows[0]?.detected_at).toBe(t0);
    expect(rows[0]?.block_reason).toBe("no website or social links");
    expect(repo.countMissedWinners()).toBe(1);
  });
});
