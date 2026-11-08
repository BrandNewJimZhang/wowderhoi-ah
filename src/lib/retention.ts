// Retention for the snapshot table. A snapshot is "an item's observation in
// one scan"; the terminal reads a rolling window (48 rows for the universe,
// 96 for the item detail) plus the daily OHLC history. Rows older than the
// widest read window have no consumer, so keeping them costs disk and
// nothing else. The daily summaries are the long-term history and are never
// pruned here.
import { prisma } from "@/lib/prisma";

// The item detail chart reads up to 96 snapshots; the universe reads 48.
export const DEFAULT_SNAPSHOT_KEEP = 96;

export async function pruneSnapshots(
  keep = DEFAULT_SNAPSHOT_KEEP,
  batchSize = 5000
): Promise<number> {
  if (!Number.isInteger(keep) || keep <= 0) {
    throw new Error(`pruneSnapshots: keep must be a positive integer, got ${keep}`);
  }
  // Retention must not destroy the phase anchor's only source. Markets
  // imported before `firstScanAt` existed have NULL there; persist the oldest
  // surviving observation before the first row is deleted.
  await prisma.$executeRaw`
    UPDATE "Market"
    SET first_scan_at = (
      SELECT MIN(timestamp) FROM "AuctionSnapshot" WHERE market_id = "Market".id
    )
    WHERE first_scan_at IS NULL
      AND EXISTS (SELECT 1 FROM "AuctionSnapshot" WHERE market_id = "Market".id)
  `;
  let deleted = 0;
  for (;;) {
    // The window function ranks each item's rows newest first; everything
    // past `keep` is superseded. Batching keeps one statement from holding
    // the write lock for the whole table.
    const count = await prisma.$executeRaw`
      DELETE FROM "AuctionSnapshot"
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY market_id, item_id ORDER BY timestamp DESC
          ) AS rn
          FROM "AuctionSnapshot"
        ) WHERE rn > ${keep}
        LIMIT ${batchSize}
      )
    `;
    deleted += count;
    if (count < batchSize) return deleted;
  }
}
