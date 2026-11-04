// Decision log: what the core recommended, for which scan generation, and
// why. It is written once per generation by the market-signals cache and
// read by the review page. When the same generation is recomputed, the
// prior rows are replaced, so the log is idempotent rather than additive.
import { prisma } from "@/lib/prisma";
import type { MarketBundle } from "@/lib/market-signals";

export async function recordDecisions(bundle: MarketBundle): Promise<void> {
  if (!bundle.latestSnapshotAt) return;
  const at = bundle.latestSnapshotAt;
  const rows = bundle.evaluation.actions.slice(0, 12).map((action) => ({
    at,
    marketId: bundle.scope?.id,
    phase: bundle.phase,
    itemId: action.itemId,
    kind: action.kind,
    context: {
      breadth: bundle.evaluation.breadth,
      ageHours: bundle.evaluation.ageHours,
      dataAgeMinutes: bundle.evaluation.dataAgeMinutes,
      realm: bundle.scope?.realm,
      faction: bundle.scope?.faction
    },
    candidates: bundle.evaluation.rows.slice(0, 12).map((row) => ({
      itemId: row.itemId,
      name: row.name,
      netProfit: row.netProfit,
      fillProb: row.fillProb,
      fillBasis: row.fillBasis,
      confidence: row.confidence
    })),
    chosen: action,
    reason: action.reason
  }));
  await prisma.$transaction([
    prisma.decision.deleteMany({ where: { at, marketId: bundle.scope?.id ?? null } }),
    ...(rows.length > 0 ? [prisma.decision.createMany({ data: rows })] : [])
  ]);
}
