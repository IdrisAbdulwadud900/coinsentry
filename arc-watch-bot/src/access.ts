import type { Logger } from "pino";

export interface EndpointResult {
  url: string;
  ok: boolean;
  detail: string;
}

export interface AccessProbe {
  /** True only when both a chain RPC and the logs API answer — discovery needs both. */
  open: boolean;
  rpc: EndpointResult[];
  logs: EndpointResult;
  headBlock: bigint | null;
}

/**
 * Cheapest possible liveness check for each endpoint, run on a slow interval
 * while access is closed. Deliberately does not reuse RpcClient: that class
 * fails over and retries to *hide* individual endpoint failures, whereas a
 * probe needs each endpoint's status reported separately and needs to stay
 * light enough to run against a gated host for weeks without looking abusive.
 */
export async function probeAccess(
  rpcUrls: string[],
  blockscoutBaseUrl: string,
  /** Whether discovery reads from the logs API. When it reads from the RPC
   * instead, a rate-limited or missing logs API must not mark the chain closed:
   * Blockscout is then only used for verification lookups and alert links,
   * both of which degrade gracefully. */
  requireLogsApi: boolean,
  logger: Logger
): Promise<AccessProbe> {
  const rpc: EndpointResult[] = await Promise.all(
    rpcUrls.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { url, ok: false, detail: `HTTP ${res.status}` };
        const body = (await res.json()) as { result?: string; error?: { message: string } };
        if (body.error) return { url, ok: false, detail: `RPC error: ${body.error.message.slice(0, 80)}` };
        if (!body.result) return { url, ok: false, detail: "no result" };
        return { url, ok: true, detail: `head ${BigInt(body.result).toString()}` };
      } catch (err) {
        return { url, ok: false, detail: String(err).slice(0, 80) };
      }
    })
  );

  const logsUrl = `${blockscoutBaseUrl.replace(/\/$/, "")}/api?module=logs&action=getLogs&fromBlock=1&toBlock=2&topic0=0x0000000000000000000000000000000000000000000000000000000000000000`;
  let logs: EndpointResult;
  try {
    const res = await fetch(logsUrl, { signal: AbortSignal.timeout(15_000) });
    // Any structured JSON reply means the API is serving; an empty result for a
    // deliberately-empty range is a success, not a failure.
    if (!res.ok) {
      logs = { url: blockscoutBaseUrl, ok: false, detail: `HTTP ${res.status}` };
    } else {
      const body = (await res.json()) as { status?: string; result?: unknown };
      const serving = body.status !== undefined || body.result !== undefined;
      logs = {
        url: blockscoutBaseUrl,
        ok: serving,
        detail: serving ? "logs API serving" : "unexpected response shape",
      };
    }
  } catch (err) {
    logs = { url: blockscoutBaseUrl, ok: false, detail: String(err).slice(0, 80) };
  }

  const liveRpc = rpc.find((r) => r.ok);
  const headBlock = liveRpc?.detail.startsWith("head ")
    ? BigInt(liveRpc.detail.slice(5))
    : null;

  const probe: AccessProbe = {
    open: Boolean(liveRpc) && (!requireLogsApi || logs.ok),
    rpc,
    logs,
    headBlock,
  };
  logger.debug({ open: probe.open, rpc: rpc.map((r) => `${r.url}: ${r.detail}`), logs: logs.detail }, "Access probe");
  return probe;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatAccessAlert(probe: AccessProbe, opened: boolean): string {
  const lines = opened
    ? [
        `<b>🟢 Arc mainnet access is OPEN</b>`,
        ``,
        `Public read access to chain 5042 is answering again. Launch scanning has resumed automatically.`,
      ]
    : [
        `<b>🔴 Arc mainnet access CLOSED</b>`,
        ``,
        `Public endpoints stopped answering. Scanning is paused; the bot keeps probing and will resume on its own.`,
      ];

  // Roles are labelled because the same host can appear as both an RPC and the
  // logs API, and "which one is down" is the whole point of the message.
  lines.push(``, `<b>Endpoints</b>`);
  for (const r of probe.rpc) {
    lines.push(`${r.ok ? "✅" : "❌"} RPC <code>${esc(new URL(r.url).host)}</code> — ${esc(r.detail)}`);
  }
  lines.push(
    `${probe.logs.ok ? "✅" : "❌"} logs <code>${esc(new URL(probe.logs.url).host)}</code> — ${esc(probe.logs.detail)}`
  );

  if (opened && probe.headBlock !== null) {
    lines.push(``, `Chain head: <b>${probe.headBlock.toString()}</b>`);
  }
  return lines.join("\n");
}
