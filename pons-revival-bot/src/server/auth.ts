import { createHmac, timingSafeEqual } from "node:crypto";
import type { preHandlerAsyncHookHandler } from "fastify";

export type VerifyInitDataResult = { ok: true; userId: string } | { ok: false };

/**
 * Verifies a Telegram Mini App `initData` string per the official spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secretKey = HMAC_SHA256(botToken, key="WebAppData")
 * expectedHash = HMAC_SHA256(dataCheckString, key=secretKey), hex-encoded
 */
export function verifyInitData(initData: string, botToken: string): VerifyInitDataResult {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const expectedBuf = Buffer.from(expectedHash, "hex");
  const actualBuf = Buffer.from(hash, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false };
  }

  const userJson = params.get("user");
  if (!userJson) return { ok: false };
  try {
    const user = JSON.parse(userJson) as { id?: number | string };
    if (user.id == null) return { ok: false };
    return { ok: true, userId: String(user.id) };
  } catch {
    return { ok: false };
  }
}

/** Fastify preHandler that requires a valid Telegram Mini App `Authorization: tma <initData>`
 * header, and that the authenticated user matches `allowedUserId` (the bot owner). */
export function requireTelegramAuth(botToken: string, allowedUserId: string): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.code(401).send({ error: "Missing Authorization header" });
      return;
    }

    const match = /^tma\s+(.+)$/i.exec(authHeader);
    if (!match || !match[1]) {
      reply.code(401).send({ error: "Invalid Authorization scheme, expected 'tma <initData>'" });
      return;
    }

    const result = verifyInitData(match[1], botToken);
    if (!result.ok) {
      reply.code(401).send({ error: "Invalid initData" });
      return;
    }

    if (result.userId !== allowedUserId) {
      reply.code(403).send({ error: "Forbidden" });
      return;
    }
  };
}
