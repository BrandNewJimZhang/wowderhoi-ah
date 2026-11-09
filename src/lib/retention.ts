// Retention for the read model. A generation is an immutable evaluation.
// Pages read the newest one and the previous one supplies the "what
// changed" comparison, so only those keep their materialised signal rows
// and core output. The quotes and scan metadata of older generations stay
// for a day because `npm run calibrate` derives fill priors from the
// disappearance between adjacent scans; keeping only two would leave one
// interval per item. Older generations cascade their quotes, and their core
// is replaced with an empty evaluation so the JSON does not accumulate.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CoreOutput } from "@/lib/core/types";
import type { MarketPhase } from "@/lib/market-rules";

export const GENERATIONS_KEPT = 2;
// One day at the compiled 15-minute cadence. Calibration rejects gaps over
// two hours, so this bounds the sample window rather than promising depth.
export const CALIBRATION_GENERATIONS_KEPT = 96;
export const DECISION_RETENTION_DAYS = 90;
export const IMPORT_RUN_RETENTION_DAYS = 30;

const EMPTY_DIAGNOSTICS: CoreOutput["diagnostics"] = {
  excluded: {},
  unfunded: { kelly: 0, exposure: 0, purse: 0, depth: 0, slots: 0 }
};

function emptyCore(phase: MarketPhase): CoreOutput {
  return {
    phase,
    rows: [],
    opportunities: [],
    actions: [],
    plan: {
      revision: "",
      steps: [],
      resources: { cashBefore: 0, cashAfter: 0, slotsBefore: 0, slotsAfter: 0 },
      unplanned: []
    },
    diagnostics: EMPTY_DIAGNOSTICS
  };
}

async function boundaryAfter(
  marketId: string,
  keep: number
): Promise<{ scannedAt: Date; phase: string } | null> {
  return prisma.marketGeneration.findFirst({
    where: { marketId },
    orderBy: { scannedAt: "desc" },
    skip: keep,
    take: 1,
    select: { scannedAt: true, phase: true }
  });
}

// Keeps the newest `keep` generations readable (signals + core) and the
// newest `calibrationKeep` generations' quotes. Returns how many generation
// rows were removed; their quotes follow by cascade.
export async function pruneGenerations(
  marketId: string,
  keep = GENERATIONS_KEPT,
  calibrationKeep = CALIBRATION_GENERATIONS_KEPT
): Promise<number> {
  if (!Number.isInteger(keep) || keep <= 0) {
    throw new Error(`pruneGenerations: keep must be a positive integer, got ${keep}`);
  }
  if (!Number.isInteger(calibrationKeep) || calibrationKeep < keep) {
    throw new Error(`pruneGenerations: calibrationKeep must be an integer >= ${keep}, got ${calibrationKeep}`);
  }

  // Everything past the read window loses the materialised view. The
  // boundary row itself is past `keep`, so it is stripped too.
  const readBoundary = await boundaryAfter(marketId, keep);
  if (readBoundary) {
    const stale = await prisma.marketGeneration.findMany({
      where: { marketId, scannedAt: { lte: readBoundary.scannedAt } },
      select: { id: true, phase: true }
    });
    if (stale.length > 0) {
      await prisma.marketSignalRow.deleteMany({
        where: { generationId: { in: stale.map((row) => row.id) } }
      });
      const idsByPhase = new Map<string, string[]>();
      for (const row of stale) {
        const ids = idsByPhase.get(row.phase) ?? [];
        ids.push(row.id);
        idsByPhase.set(row.phase, ids);
      }
      for (const [phase, ids] of idsByPhase) {
        await prisma.marketGeneration.updateMany({
          where: { id: { in: ids } },
          data: { core: emptyCore(phase as MarketPhase) as unknown as Prisma.InputJsonValue }
        });
      }
    }
  }

  const calibrationBoundary = await boundaryAfter(marketId, calibrationKeep);
  if (!calibrationBoundary) return 0;
  const deleted = await prisma.marketGeneration.deleteMany({
    where: { marketId, scannedAt: { lte: calibrationBoundary.scannedAt } }
  });
  return deleted.count;
}

export async function pruneAgedRows(now = new Date()): Promise<{ decisions: number; importRuns: number }> {
  const decisionCutoff = new Date(now.getTime() - DECISION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const runCutoff = new Date(now.getTime() - IMPORT_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // Trades outlive the decision log. A trade that still cites a decision
  // keeps that row: deleting it would leave an id no replay can reconstruct
  // (adoption events only name the id, not the item or kind). SQLite stores
  // DateTime columns as integer milliseconds, so the cutoff binds the same
  // value a Prisma filter would.
  const [decisions, importRuns] = await Promise.all([
    prisma.$executeRawUnsafe(
      `DELETE FROM "Decision"
       WHERE "at" < ?
         AND ("decision_id" IS NULL OR "decision_id" NOT IN (
           SELECT "decision_id" FROM "Trade" WHERE "decision_id" IS NOT NULL
         ))`,
      decisionCutoff.getTime()
    ),
    prisma.importRun.deleteMany({ where: { receivedAt: { lt: runCutoff } } })
  ]);
  // A superseded plan with no surviving decision is history the review can
  // no longer read. Fresh plans and plans still cited by a decision stay:
  // the decision log is the immutable record, not the plan table.
  await prisma.plan.deleteMany({
    where: {
      createdAt: { lt: decisionCutoff },
      supersededAt: { not: null },
      decisions: { none: {} }
    }
  });
  return { decisions, importRuns: importRuns.count };
}
