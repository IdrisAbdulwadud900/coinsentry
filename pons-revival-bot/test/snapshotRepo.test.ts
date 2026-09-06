import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/data/db.js";
import { TokenRepo } from "../src/data/tokenRepo.js";
import { SnapshotRepo } from "../src/data/snapshotRepo.js";

describe("housekeeping", () => {
  // Retention used to be the last statement of the poll cycle, so it only ran when every
  // sweep before it succeeded. They stopped succeeding, 2.7M expired rows accumulated, the
  // WAL grew to 363MB beside a 641MB database, and the 1GB volume filled — after which
  // SQLite could not open the file at all and the machine hit its restart limit.
  it("deletes snapshots past the cutoff and keeps newer ones", () => {
    const db = openDatabase(":memory:");
    const tokenRepo = new TokenRepo(db);
    const repo = new SnapshotRepo(db);
    const now = Date.now();
    const addr = "0xaa00000000000000000000000000000000000001";
    tokenRepo.insertIfNew(addr, "T", "T", "0xp", "active", null, null, now - 86400000);

    const snap = {
      tokenAddress: addr, symbol: "T", name: "T", priceUsd: 1, marketCapUsd: 5000,
      liquidityUsd: 3000, volume5m: 1, volume1h: 10, volume24h: 100, buys5m: 1, buys1h: 2,
      sells1h: 1, imageUrl: null, websiteUrl: null, socials: [], dexUrl: "", pairCreatedAt: null,
    };
    repo.insert(snap, now - 5 * 86400000); // stale
    repo.insert(snap, now - 60000); // fresh

    const pruned = repo.pruneOlderThan(now - 3 * 86400000);

    expect(pruned).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM snapshots").get()).toEqual({ c: 1 });
  });

  it("checkpoints the WAL without throwing", () => {
    const db = openDatabase(":memory:");
    // Must be safe to call every cycle, including when there is nothing to fold in.
    expect(() => new SnapshotRepo(db).checkpointWal()).not.toThrow();
  });
});
