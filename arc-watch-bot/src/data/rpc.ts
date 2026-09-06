import type { Logger } from "pino";

/**
 * Minimal JSON-RPC client with per-call failover across the configured endpoints.
 * Arc's public RPCs are individually flaky (thirdweb 500s outright; the others
 * occasionally rate-limit), but so far never all at once — a request is only a
 * hard failure after every endpoint has rejected it.
 */
export class RpcClient {
  private readonly urls: string[];
  private readonly logger: Logger;

  constructor(urls: string[], logger: Logger) {
    if (urls.length === 0) throw new Error("RpcClient needs at least one endpoint URL");
    this.urls = urls;
    this.logger = logger;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    // Two passes with a pause between them: both public endpoints rate-ban
    // briefly under burst load, and a single retry after a beat recovers
    // nearly everything a one-shot failover would lose.
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) await new Promise((r) => setTimeout(r, 2000));
      const result = await this.tryEndpoints<T>(method, params);
      if (result.ok) return result.value;
      lastError = result.error;
    }
    throw new Error(`All RPC endpoints failed for ${method}: ${String(lastError)}`);
  }

  private async tryEndpoints<T>(
    method: string,
    params: unknown[]
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    let lastError: unknown;
    for (const url of this.urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
        return { ok: true, value: body.result as T };
      } catch (err) {
        lastError = err;
        this.logger.debug({ url, method, err: String(err) }, "RPC endpoint failed, trying next");
      }
    }
    return { ok: false, error: lastError };
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_blockNumber", []));
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async transactionFrom(txHash: string): Promise<string | null> {
    const tx = await this.call<{ from?: string } | null>("eth_getTransactionByHash", [txHash]);
    return tx?.from?.toLowerCase() ?? null;
  }
}

const SELECTOR_NAME = "0x06fdde03";
const SELECTOR_SYMBOL = "0x95d89b41";
const SELECTOR_DECIMALS = "0x313ce567";
const SELECTOR_BALANCE_OF = "0x70a08231";

function decodeString(hex: string): string | null {
  if (!hex || hex === "0x") return null;
  const raw = hex.slice(2);
  try {
    // Standard ABI-encoded string: offset word, length word, then data.
    const len = parseInt(raw.slice(64, 128), 16);
    if (!Number.isFinite(len) || len === 0 || len > 256) return null;
    const bytes = raw.slice(128, 128 + len * 2);
    const decoded = Buffer.from(bytes, "hex").toString("utf8").replace(/\0/g, "").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export interface TokenIdentity {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export async function readTokenIdentity(rpc: RpcClient, token: string): Promise<TokenIdentity> {
  const [nameHex, symbolHex, decimalsHex] = await Promise.allSettled([
    rpc.ethCall(token, SELECTOR_NAME),
    rpc.ethCall(token, SELECTOR_SYMBOL),
    rpc.ethCall(token, SELECTOR_DECIMALS),
  ]);
  return {
    name: nameHex.status === "fulfilled" ? decodeString(nameHex.value) : null,
    symbol: symbolHex.status === "fulfilled" ? decodeString(symbolHex.value) : null,
    decimals:
      decimalsHex.status === "fulfilled" && decimalsHex.value !== "0x"
        ? parseInt(decimalsHex.value, 16)
        : null,
  };
}

/** ERC-20 balanceOf(holder) on `token`, as a bigint of raw units. */
export async function readBalanceOf(rpc: RpcClient, token: string, holder: string): Promise<bigint> {
  const data = SELECTOR_BALANCE_OF + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hex = await rpc.ethCall(token, data);
  return hex && hex !== "0x" ? BigInt(hex) : 0n;
}
