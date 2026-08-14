import type { Logger } from "pino";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Real, on-chain authority status of an SPL token mint.
 *
 * `freezeAuthorityActive` is the single most important safety signal on Solana: while a
 * freeze authority exists, whoever holds it can freeze any holder's token account, making
 * the token impossible to sell. That is precisely the Solana form of a honeypot, and it's
 * why an active freeze authority blocks an alert outright.
 *
 * `mintAuthorityActive` means new supply can still be printed at will (dilution / soft rug).
 * Both are shown to the owner; only the freeze authority blocks.
 */
export interface SolanaMintSafety {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  /** Combined share of supply held by the largest wallets, per Jupiter's audit data.
   * Jupiter does not document how many wallets this covers, so it is deliberately
   * labelled "Top Holders" rather than claiming a top-10 figure. Null when unknown. */
  topHoldersPct?: number | null;
  /** Real holder count, when known. */
  holderCount?: number | null;
  /** Jupiter's own organic-activity rating ("high"/"medium"/"low") — a real published
   * score, not a figure this bot derives. */
  organicScoreLabel?: string | null;
  /** Token icon from Jupiter, used as another real image source for alerts. */
  iconUrl?: string | null;
}

/**
 * Minimal Solana JSON-RPC client — plain `fetch`, no SDK dependency. Only uses light
 * methods that free public RPC endpoints actually allow (`getAccountInfo`), so the
 * default endpoint works without an API key. Every failure returns null so a degraded
 * RPC omits a line rather than fabricating or blocking a cycle.
 */
export class SolanaClient {
  constructor(
    private readonly logger: Logger,
    private readonly rpcUrl: string
  ) {}

  private async rpc(method: string, params: unknown[]): Promise<unknown | null> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn({ method, status: res.status }, "Solana RPC request failed");
        return null;
      }
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) {
        // Public endpoints throttle heavier methods; that's expected, not exceptional.
        this.logger.debug({ method, err: body.error.message }, "Solana RPC returned an error");
        return null;
      }
      return body.result ?? null;
    } catch (err) {
      this.logger.warn({ method, err: String(err) }, "Solana RPC call threw");
      return null;
    }
  }

  /**
   * Reads a mint's authority status. Returns null when the account can't be read or isn't
   * a parseable SPL mint — the caller then omits the line rather than assuming "safe",
   * which would be the dangerous default.
   */
  async fetchMintSafety(mintAddress: string): Promise<SolanaMintSafety | null> {
    const result = (await this.rpc("getAccountInfo", [mintAddress, { encoding: "jsonParsed" }])) as
      | { value?: { data?: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } } } }
      | null;

    const info = result?.value?.data?.parsed?.info;
    if (!info || !("mintAuthority" in info || "freezeAuthority" in info)) return null;

    return {
      mintAuthorityActive: info.mintAuthority != null,
      freezeAuthorityActive: info.freezeAuthority != null,
    };
  }
}
