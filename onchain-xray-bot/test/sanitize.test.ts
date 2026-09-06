import { describe, it, expect } from 'vitest';
import { rejectPriceOutliers } from '../src/engine/sanitize.js';
import type { Trade } from '../src/types/domain.js';

const SUPPLY = 1_000_000_000;

function t(over: Partial<Trade> & { priceUsd: number; usd: number }): Trade {
  return {
    ts: 1000,
    wallet: 'w',
    side: 'buy',
    tokenAmount: over.usd / over.priceUsd,
    mcap: over.priceUsd * SUPPLY,
    tx: 'sig',
    block: 1,
    ...over,
  } as Trade;
}

/** A run of ordinary trades at roughly the real price. */
function baseline(n: number, price = 0.000027): Trade[] {
  return Array.from({ length: n }, (_, i) =>
    t({ ts: 1000 + i, priceUsd: price * (1 + (i % 5) * 0.01), usd: 60 }),
  );
}

describe('rejectPriceOutliers', () => {
  it('drops the isolated 10x dust spike seen on live data', () => {
    const trades = [...baseline(30)];
    // The $GARY artifact: $1.24 implying ~10x the surrounding price.
    trades.splice(15, 0, t({ ts: 1015, priceUsd: 0.000279, usd: 1.244 }));
    const { trades: kept, dropped } = rejectPriceOutliers(trades);
    expect(dropped).toBe(1);
    expect(kept.some((x) => x.usd === 1.244)).toBe(false);
  });

  it('drops a smaller 4.8x dust spike that a flat USD floor would keep', () => {
    const trades = [...baseline(30)];
    trades.splice(15, 0, t({ ts: 1015, priceUsd: 0.00013, usd: 1.9 }));
    const { dropped } = rejectPriceOutliers(trades);
    expect(dropped).toBe(1);
  });

  it('keeps a large trade that deviates — size means it moved the market', () => {
    const trades = [...baseline(30)];
    trades.splice(15, 0, t({ ts: 1015, priceUsd: 0.000135, usd: 5000 }));
    const { dropped } = rejectPriceOutliers(trades);
    expect(dropped).toBe(0);
  });

  it('preserves a genuine sustained ramp', () => {
    // A launch that climbs 100x across its history: neighbours climb with it,
    // so no individual trade looks isolated.
    const trades = Array.from({ length: 60 }, (_, i) =>
      t({ ts: 1000 + i, priceUsd: 0.00001 * 1.08 ** i, usd: 40 }),
    );
    const { dropped } = rejectPriceOutliers(trades);
    expect(dropped).toBe(0);
  });

  it('leaves short histories untouched', () => {
    const trades = baseline(8);
    expect(rejectPriceOutliers(trades).dropped).toBe(0);
  });

  it('does not let a cluster of artifacts vouch for each other', () => {
    const trades = [...baseline(40)];
    for (let i = 0; i < 3; i++) {
      trades.splice(10 + i * 6, 0, t({ ts: 1010 + i * 6, priceUsd: 0.00028, usd: 1.2 }));
    }
    const { dropped } = rejectPriceOutliers(trades);
    expect(dropped).toBe(3);
  });
});

describe('credential redaction', () => {
  it('strips api keys from query strings', async () => {
    const { redactUrl } = await import('../src/util/http.js');
    expect(redactUrl('https://api.helius.xyz/v0/transactions?api-key=SECRET123')).toBe(
      'https://api.helius.xyz/v0/transactions?api-key=***',
    );
    expect(redactUrl('https://x.io/a?foo=1&apiKey=SECRET&bar=2')).toContain('apiKey=***');
    expect(redactUrl('https://x.io/a?token=SECRET')).toContain('token=***');
  });

  it('strips a key embedded in the Helius RPC path', async () => {
    const { redactUrl } = await import('../src/util/http.js');
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=SECRET')).not.toContain('SECRET');
  });

  it('keeps the key out of a thrown error, which pino serializes verbatim', async () => {
    const { HttpError } = await import('../src/util/http.js');
    const err = new HttpError(429, 'https://api.helius.xyz/v0/transactions?api-key=SECRET123', 'Too Many Requests');
    expect(err.message).not.toContain('SECRET123');
    expect(err.url).not.toContain('SECRET123');
    expect(JSON.stringify(err)).not.toContain('SECRET123');
  });
});

describe('candle series must describe the right asset', () => {
  it('reads the quote side when our token is not the pool base', async () => {
    // Regression: a BNB Chain pool listed WBNB as base and the token as quote,
    // so default OHLCV returned WBNB's ~$735 price and a $186k coin was
    // reported as peaking at $735 billion.
    const { CandleIndex } = await import('../src/data/ohlcv.js');
    const wrong = new CandleIndex({
      candles: [{ ts: 100, open: 735, high: 735.4, low: 730, close: 735, period: 3_600 }],
      periodSeconds: 3_600,
      coversFrom: 100,
    });
    // The index itself is agnostic — it reports what it was given. The guard
    // lives in the caller, which compares the close against the known price.
    expect(wrong.high).toBeCloseTo(735.4, 1);

    const right = new CandleIndex({
      candles: [{ ts: 100, open: 0.0005, high: 0.00050895, low: 0.0004, close: 0.0005, period: 3_600 }],
      periodSeconds: 3_600,
      coversFrom: 100,
    });
    expect(right.high * 1e9).toBeCloseTo(508_950, -2);
  });
});

describe('sparkline series', () => {
  it('samples candles evenly in time, not by index', async () => {
    const { CandleIndex } = await import('../src/data/ohlcv.js');
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    // Deliberately uneven: three candles bunched early, one far later. Index
    // sampling would give the busy stretch three quarters of the chart.
    const idx = new CandleIndex({
      candles: [
        { ts: 0, open: 1e-6, high: 1e-6, low: 1e-6, close: 1e-6, period: 60 },
        { ts: 60, open: 2e-6, high: 2e-6, low: 2e-6, close: 2e-6, period: 60 },
        { ts: 120, open: 3e-6, high: 3e-6, low: 3e-6, close: 3e-6, period: 60 },
        { ts: 100_000, open: 9e-6, high: 9e-6, low: 9e-6, close: 9e-6, period: 60 },
      ],
      periodSeconds: 60,
      coversFrom: 0,
    });
    const series = new PriceCurve([]).withCandles(idx, 1e9).series(8);
    expect(series).toHaveLength(8);

    // The three early candles occupy 120 of 100,000 seconds, so they must take
    // roughly one sample between them — not the three-eighths of the chart that
    // index-based sampling would have given them.
    const early = series.filter((v) => v < 3e-6 * 1e9 - 1).length;
    expect(early).toBeLessThanOrEqual(2);

    // The long quiet stretch holds the last known close, which is the truth:
    // the price sat at 3e-6 for almost the entire span.
    const held = series.filter((v) => Math.abs(v - 3e-6 * 1e9) < 1).length;
    expect(held).toBeGreaterThan(series.length / 2);

    // Endpoints are the real first and last closes.
    expect(series[0]).toBeCloseTo(1e-6 * 1e9, 0);
    expect(series[series.length - 1]).toBeCloseTo(9e-6 * 1e9, 0);
  });

  it('falls back to trades when no candles are attached', async () => {
    const { PriceCurve } = await import('../src/engine/priceCurve.js');
    const t = (ts: number, p: number) => ({
      ts, wallet: 'w', side: 'buy' as const, tokenAmount: 1, usd: p,
      priceUsd: p, mcap: p * 1e9, tx: 'x', block: ts,
    });
    const series = new PriceCurve([t(1, 1e-6), t(2, 2e-6), t(3, 3e-6)]).series(3);
    expect(series).toHaveLength(3);
  });
});

describe('secrets never reach the log', () => {
  it('redacts a Telegram bot token from a URL path', async () => {
    // Telegram puts the token in the PATH, so the query-parameter rules never
    // saw it. One timed-out startup call wrote the whole token to disk.
    const { redactUrl } = await import('../src/util/http.js');
    const url = 'https://api.telegram.org/bot8993736629:AAGQHgYnXH8sNTtxFv8EY/setMyCommands';
    const safe = redactUrl(url);
    expect(safe).not.toContain('AAGQHgYnXH8sNTtxFv8EY');
    expect(safe).not.toContain('8993736629');
    expect(safe).toContain('api.telegram.org/bot***');
  });

  it('still redacts api keys in query strings and Helius paths', async () => {
    const { redactUrl } = await import('../src/util/http.js');
    expect(redactUrl('https://x.com/v1?api-key=SECRET123')).not.toContain('SECRET123');
    expect(redactUrl('https://mainnet.helius-rpc.com/SECRET123')).not.toContain('SECRET123');
  });

  it('scrubs a nested third-party error, not just our own', async () => {
    // grammy's errors are not ours to redact at construction, and they nest the
    // failing URL a couple of levels down.
    const { log } = await import('../src/util/log.js');
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // pino-pretty writes through stdout in dev; capture whatever comes out.
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      lines.push(String(s));
      return true;
    };
    try {
      const err = new Error('Network request failed!') as Error & { error?: unknown };
      err.error = { message: 'request to https://api.telegram.org/botSECRETTOKEN/x failed' };
      log.error({ err }, 'boom');
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    expect(lines.join('')).not.toContain('SECRETTOKEN');
  });
});
