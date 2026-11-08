// Retention for the read model. A generation is an immutable evaluation;
// the terminal reads the newest one, and keeps the previous one for the
// "what changed" comparison. Older generations cascade their quotes and
// signal rows. Decisions live longer because the review page learns from
// them; import runs are diagnostics with a short life.
import { prisma } from "@/lib/prisma";

export const GENERATIONS_KEPT = 2;
export const DECISION_RETENTION_DAYS = 90;
export const IMPORT_RUN_RETENTION_DAYS = 30;

// Keeps the newest `keep` generations for one market and returns how many
// metadata rows were removed. Quotes and signals follow by cascade.
export async function pruneGenerations(marketId: string, keep = GENERATIONS_KEPT): Promise<number> {
  if (!Number.isInteger(keep) || keep <= 0) {
    throw new Error(`pruneGenerations: keep must be a positive integer, got ${keep}`);
  }
  const boundary = await prisma.marketGeneration.findFirst({
    where: { marketId },
    orderBy: { scannedAt: "desc" },
    skip: keep,
    take: 1,
    select: { scannedAt: true }
  });
  if (!boundary) return 0;
  const deleted = await prisma.marketGeneration.deleteMany({
    where: { marketId, scannedAt: { lt: boundary.scannedAt } }
  });
  return deleted.count;
}

export async function pruneAgedRows(now = new Date()): Promise<{ decisions: number; importRuns: number }> {
  const decisionCutoff = new Date(now.getTime() - DECISION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const runCutoff = new Date(now.getTime() - IMPORT_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [decisions, importRuns] = await Promise.all([
    prisma.decision.deleteMany({ where: { at: { lt: decisionCutoff } } }),
    prisma.importRun.deleteMany({ where: { receivedAt: { lt: runCutoff } } })
  ]);
  return { decisions: decisions.count, importRuns: importRuns.count };
}

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
