import type { Db } from "./db.js";
import type { AlertRow } from "../types/domain.js";

export class AlertRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    address: string;
    ts: number;
    dryRun: boolean;
    volume1h: number | null;
    buys1h: number | null;
    liquidityUsd: number | null;
    priceUsd: number | null;
    baselineMedianVolume1h: number;
    baselineMedianLiquidityUsd: number;
    deadForHours: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO alerts
          (address, ts, dry_run, volume_1h, buys_1h, liquidity_usd, price_usd,
           baseline_median_volume_1h, baseline_median_liquidity_usd, dead_for_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.address.toLowerCase(),
        row.ts,
        row.dryRun ? 1 : 0,
        row.volume1h,
        row.buys1h,
        row.liquidityUsd,
        row.priceUsd,
        row.baselineMedianVolume1h,
        row.baselineMedianLiquidityUsd,
        row.deadForHours
      );
  }

  list(limit: number, offset: number): AlertRow[] {
    return this.db
      .prepare<[number, number], AlertRow>("SELECT * FROM alerts ORDER BY ts DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
  }

  count(): number {
    const row = this.db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM alerts").get();
    return row?.count ?? 0;
  }
}
