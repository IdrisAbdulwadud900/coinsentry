import type { Logger } from "pino";
import type { LogSource, RawLog } from "./logSource.js";

/**
 * Client for Arc's Blockscout instance. Discovery uses the Etherscan-compatible
 * logs API rather than eth_getLogs because it is the only interface that has
 * accepted unrestricted block ranges on every Arc endpoint tested; responses
 * are capped at 1000 records, which callers must respect by chunking ranges.
 */
export class BlockscoutClient implements LogSource {
  private readonly base: string;
  private readonly logger: Logger;
  /** Blockscout's Etherscan-compatible logs endpoint caps a response here. */
  readonly maxRecords = 1000;

  constructor(baseUrl: string, logger: Logger) {
    this.base = baseUrl.replace(/\/$/, "");
    this.logger = logger;
  }

  async getLogs(fromBlock: bigint, toBlock: bigint, topic0: string): Promise<RawLog[]> {
    return this.query(fromBlock, toBlock, topic0, null);
  }

  async getLogsForAddress(
    address: string,
    fromBlock: bigint,
    toBlock: bigint,
    topic0: string
  ): Promise<RawLog[]> {
    return this.query(fromBlock, toBlock, topic0, address);
  }

  private async query(
    fromBlock: bigint,
    toBlock: bigint,
    topic0: string,
    address: string | null
  ): Promise<RawLog[]> {
    const url =
      `${this.base}/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&topic0=${topic0}` +
      (address ? `&address=${address}` : "");
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Blockscout logs HTTP ${res.status}`);
    const body = (await res.json()) as { status: string; message?: string; result: unknown };
    // Only a genuine empty array means "no launches in this range". Every other
    // shape must throw so the caller leaves its cursor alone and rescans later.
    // Rate limiting in particular replies {status:"0", result:null}, which an
    // earlier version of this code read as "no records" — that silently advanced
    // the cursor past unscanned blocks and lost those launches permanently,
    // because the cursor never goes backwards.
    if (!Array.isArray(body.result)) {
      throw new Error(
        `Blockscout logs error (status ${body.status}): ${body.message ?? JSON.stringify(body.result).slice(0, 200)}`
      );
    }
    return body.result.map((l) => {
      const log = l as { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };
      return {
        address: log.address.toLowerCase(),
        topics: log.topics,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
      };
    });
  }

  /** True / false when Blockscout knows the answer; null when the lookup failed. */
  async isContractVerified(address: string): Promise<boolean | null> {
    try {
      const res = await fetch(`${this.base}/api/v2/smart-contracts/${address}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) return false;
      if (!res.ok) return null;
      const body = (await res.json()) as { is_verified?: boolean };
      return body.is_verified ?? false;
    } catch (err) {
      this.logger.debug({ address, err: String(err) }, "Verified-contract lookup failed");
      return null;
    }
  }

  tokenUrl(address: string): string {
    return `${this.base}/token/${address}`;
  }

  addressUrl(address: string): string {
    return `${this.base}/address/${address}`;
  }

  txUrl(hash: string): string {
    return `${this.base}/tx/${hash}`;
  }
}
