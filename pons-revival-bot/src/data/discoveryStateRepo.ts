import type { Db } from "./db.js";

export class DiscoveryStateRepo {
  constructor(private readonly db: Db) {}

  getLastScannedBlock(factoryAddress: string): bigint | undefined {
    const row = this.db
      .prepare<[string], { last_scanned_block: string }>(
        "SELECT last_scanned_block FROM discovery_state WHERE factory_address = ?"
      )
      .get(factoryAddress);
    return row ? BigInt(row.last_scanned_block) : undefined;
  }

  setLastScannedBlock(factoryAddress: string, block: bigint): void {
    this.db
      .prepare(
        `INSERT INTO discovery_state (factory_address, last_scanned_block)
         VALUES (?, ?)
         ON CONFLICT(factory_address) DO UPDATE SET last_scanned_block = excluded.last_scanned_block`
      )
      .run(factoryAddress, block.toString());
  }
}
