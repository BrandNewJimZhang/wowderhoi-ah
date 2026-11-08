// Retention for the read model. A generation is an immutable evaluation;
// the terminal reads the newest one, and keeps the previous one for the
// "what changed" comparison. Older generations cascade their quotes and
// signal rows. Decisions live longer because the review page learns from
// them; import runs are diagnostics with a short life.
import { prisma } from "@/lib/prisma";

const GENERATIONS_KEPT = 2;
const DECISION_RETENTION_DAYS = 90;
const IMPORT_RUN_RETENTION_DAYS = 30;

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
  // The boundary row is the first one past `keep`; it is deleted too, or
  // the table would silently keep one more generation than asked for.
  const deleted = await prisma.marketGeneration.deleteMany({
    where: { marketId, scannedAt: { lte: boundary.scannedAt } }
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
