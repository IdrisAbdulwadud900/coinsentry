import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../src/server/auth.js";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

/** Builds a valid initData string + hash exactly the way Telegram does, so tests can
 * verify the round trip without depending on a real Telegram client. */
function buildInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

describe("verifyInitData", () => {
  it("verifies a correctly signed initData string and extracts the user id", () => {
    const initData = buildInitData({
      user: JSON.stringify({ id: 987654321, first_name: "Test" }),
      auth_date: "1700000000",
      query_id: "abc123",
    });

    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ ok: true, userId: "987654321" });
  });

  it("rejects initData signed with a different bot token", () => {
    const initData = buildInitData(
      { user: JSON.stringify({ id: 1, first_name: "Test" }), auth_date: "1700000000" },
      "different:token"
    );

    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ ok: false });
  });

  it("rejects tampered initData (field modified after signing)", () => {
    const initData = buildInitData({
      user: JSON.stringify({ id: 1, first_name: "Test" }),
      auth_date: "1700000000",
    });
    const tampered = initData.replace("auth_date=1700000000", "auth_date=1700000001");

    const result = verifyInitData(tampered, BOT_TOKEN);
    expect(result).toEqual({ ok: false });
  });

  it("rejects initData with a missing hash", () => {
    const params = new URLSearchParams({ user: JSON.stringify({ id: 1 }) });
    const result = verifyInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ ok: false });
  });

  it("rejects initData with a missing user field", () => {
    const initData = buildInitData({ auth_date: "1700000000" });
    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ ok: false });
  });
});
