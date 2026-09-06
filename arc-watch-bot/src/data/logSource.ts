import type { RpcClient } from "./rpc.js";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
}

/**
 * Where discovery reads factory events from. Two backends exist because the
 * chains differ in what they allow:
 *
 *  - Arc's public RPC rejects eth_getLogs outright, so its Blockscout instance
 *    is the only way in.
 *  - Robinhood Chain's Blockscout rate-limits the free tier far below what a
 *    ~20k-pools-per-day chain needs, while its RPC serves 20k-block getLogs
 *    ranges without complaint.
 *
 * `maxRecords` is the backend's response cap; discovery uses it to detect a
 * possibly-truncated window and re-scan it in smaller pieces.
 */
export interface LogSource {
  getLogs(fromBlock: bigint, toBlock: bigint, topic0: string): Promise<RawLog[]>;
  /** Same query narrowed to one contract — used to read a single token's own
   * Transfer events when assessing launch quality. */
  getLogsForAddress(address: string, fromBlock: bigint, toBlock: bigint, topic0: string): Promise<RawLog[]>;
  readonly maxRecords: number;
}

interface JsonRpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

export class RpcLogSource implements LogSource {
  private readonly rpc: RpcClient;
  readonly maxRecords: number;

  constructor(rpc: RpcClient, maxRecords: number) {
    this.rpc = rpc;
    this.maxRecords = maxRecords;
  }

  async getLogs(fromBlock: bigint, toBlock: bigint, topic0: string): Promise<RawLog[]> {
    return this.query({
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [topic0],
    });
  }

  async getLogsForAddress(
    address: string,
    fromBlock: bigint,
    toBlock: bigint,
    topic0: string
  ): Promise<RawLog[]> {
    return this.query({
      address,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [topic0],
    });
  }

  private async query(filter: Record<string, unknown>): Promise<RawLog[]> {
    const logs = await this.rpc.call<JsonRpcLog[]>("eth_getLogs", [filter]);
    // A null result would mean the node answered without data; treating it as an
    // empty range would advance the cursor past unscanned blocks, so it throws.
    if (!Array.isArray(logs)) {
      throw new Error(`eth_getLogs returned a non-array result for ${JSON.stringify(filter)}`);
    }
    return logs.map((l) => ({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      blockNumber: BigInt(l.blockNumber),
      transactionHash: l.transactionHash,
    }));
  }
}
