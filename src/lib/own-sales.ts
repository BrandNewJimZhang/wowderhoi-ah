// Clean fill labels for the shared decision core: collected auction sales
// only. The in-game ledger and the terminal's trade table are two sources
// of the same rows, so the aggregation lives here once and both call it.
import type { OwnSales } from "@/lib/core/types";
import { SCAN_INTERVAL_MINUTES, fillRules } from "@/lib/market-rules";

type OwnSaleRow = {
  itemId: number;
  qty: number;
  realizedAt: Date;
  listedAt: Date | null;
};

export function ownSalesFromRows(rows: readonly OwnSaleRow[], now: Date = new Date()): OwnSales {
  const since = now.getTime() - fillRules.ownSalesWindowDays * 24 * 60 * 60 * 1000;
  const floorMs = SCAN_INTERVAL_MINUTES * 60 * 1000;
  const byItem = new Map<number, { qty: number; samples: number; exposureMs: number }>();
  for (const row of rows) {
    const observedAt = row.realizedAt.getTime();
    if (observedAt < since) continue;
    // Exposure is per sale: how long that listing waited on the book. The
    // span between the first and last sale understates it when several
    // listings sold close together. A missing posting time uses the scan
    // interval as the floor, the same lower bound the in-game ledger has.
    const listedAt = row.listedAt?.getTime() ?? observedAt - floorMs;
    const exposure = Math.max(observedAt - listedAt, floorMs);
    const record = byItem.get(row.itemId) ?? { qty: 0, samples: 0, exposureMs: 0 };
    record.qty += row.qty;
    record.samples += 1;
    record.exposureMs += exposure;
    byItem.set(row.itemId, record);
  }
  return Object.fromEntries(
    Array.from(byItem.entries()).map(([itemId, record]) => [
      itemId,
      {
        qty: record.qty,
        samples: record.samples,
        exposedHours: Math.max(record.exposureMs / (60 * 60 * 1000), SCAN_INTERVAL_MINUTES / 60)
      }
    ])
  );
}
