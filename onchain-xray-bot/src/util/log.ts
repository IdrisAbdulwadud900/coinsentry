import pino from 'pino';
import { config } from '../config.js';
import { redactUrl } from './http.js';

/**
 * Scrubs secrets out of anything on its way to the log.
 *
 * Errors raised by our own code are redacted where they are constructed, but
 * third-party ones are not — grammy's network errors carry the full Telegram
 * API URL, and the bot token lives in that path. One timed-out startup call
 * was enough to write the token to disk in plaintext.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactUrl(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Error) {
    // Errors do not spread, and their message and stack are the two places a
    // URL actually shows up.
    const copy: Record<string, unknown> = {
      name: value.name,
      message: redactUrl(value.message),
      stack: value.stack ? redactUrl(value.stack) : undefined,
    };
    for (const key of Object.keys(value)) {
      copy[key] = scrub((value as unknown as Record<string, unknown>)[key], depth + 1);
    }
    return copy;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return value;
}

export const log = pino({
  level: config.LOG_LEVEL,
  formatters: {
    log: (obj) => scrub(obj) as Record<string, unknown>,
  },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
