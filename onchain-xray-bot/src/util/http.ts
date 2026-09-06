import { log } from './log.js';

/**
 * Strips credentials from a URL before it can reach a log, an error message, or
 * a Telegram reply. Keys arrive both as query parameters and as path segments,
 * and an error object carrying a raw URL will be serialized in full by the
 * logger, so redaction has to happen at construction rather than at print time.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&](?:api[-_]?key|apikey|key|token|access[-_]?token)=)[^&]+/gi, '$1***')
    .replace(/(helius-rpc\.com\/)[^?#/]+/gi, '$1***')
    // Telegram puts the bot token in the PATH, not a query parameter, so the
    // rule above never saw it. A single failed startup call printed the whole
    // token to the log, because the error came from grammy rather than from
    // here and arrived at the logger with its URL intact.
    .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, '$1***');
}

export class HttpError extends Error {
  readonly url: string;

  constructor(
    readonly status: number,
    url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${redactUrl(url)}`);
    this.name = 'HttpError';
    // Stored redacted: pino serializes error properties verbatim.
    this.url = redactUrl(url);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /** Status codes that should NOT be retried (beyond the 4xx default). */
  noRetryOn?: number[];
}

/**
 * fetch with timeout, exponential backoff, and Retry-After support.
 * 4xx (except 408/429) fail fast — retrying an auth error just burns time.
 */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 25_000, retries = 3, noRetryOn = [], ...init } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');
      const retryable =
        !noRetryOn.includes(res.status) &&
        (res.status === 408 || res.status === 429 || res.status >= 500);

      if (!retryable || attempt === retries) throw new HttpError(res.status, url, body.slice(0, 300));

      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 600 + Math.random() * 400, 12_000);
      log.debug({ url: redactUrl(url), status: res.status, waitMs }, 'retrying request');
      await sleep(waitMs);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt === retries) break;
      await sleep(Math.min(2 ** attempt * 600, 8_000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Minimal JSON-RPC helper shared by the Solana and EVM clients. */
export async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  opts: FetchOpts = {},
): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { message: string; code: number } }>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    ...opts,
  });
  if (res.error) throw new Error(`RPC ${method} failed: ${res.error.message} (${res.error.code})`);
  return res.result as T;
}


/** Simple token-bucket limiter so free tiers don't 429 us into oblivion. */
export class RateLimiter {
  private queue: (() => void)[] = [];
  private active = 0;
  private lastStart = 0;

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs = 0,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.minIntervalMs > 0) {
        const wait = this.lastStart + this.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      this.lastStart = Date.now();
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Runs `fn` over every item, respecting the limiter. Order is preserved. */
  async map<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, i) => this.run(() => fn(item, i))));
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
