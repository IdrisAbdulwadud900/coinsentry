import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Db } from "../src/data/db.js";
import { SettingsRepo } from "../src/data/settingsRepo.js";

describe("SettingsRepo", () => {
  let db: Db;
  let repo: SettingsRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new SettingsRepo(db);
  });

  it("returns undefined for a key that was never set", () => {
    expect(repo.get("deadMinAgeHours")).toBeUndefined();
  });

  it("set then get round-trips the value", () => {
    repo.set("deadMinAgeHours", "48", Date.now());
    expect(repo.get("deadMinAgeHours")).toBe("48");
  });

  it("set overwrites an existing value for the same key", () => {
    repo.set("deadMinAgeHours", "48", Date.now());
    repo.set("deadMinAgeHours", "72", Date.now());
    expect(repo.get("deadMinAgeHours")).toBe("72");
  });

  it("delete removes a stored key", () => {
    repo.set("deadMinAgeHours", "48", Date.now());
    repo.delete("deadMinAgeHours");
    expect(repo.get("deadMinAgeHours")).toBeUndefined();
  });

  it("delete is a no-op for a key that was never set", () => {
    expect(() => repo.delete("neverSet")).not.toThrow();
  });

  it("getAll returns every stored key/value pair", () => {
    repo.set("deadMinAgeHours", "48", Date.now());
    repo.set("revivalConfirmPolls", "5", Date.now());
    expect(repo.getAll()).toEqual({ deadMinAgeHours: "48", revivalConfirmPolls: "5" });
  });

  it("getAll returns an empty object when nothing is stored", () => {
    expect(repo.getAll()).toEqual({});
  });
});
