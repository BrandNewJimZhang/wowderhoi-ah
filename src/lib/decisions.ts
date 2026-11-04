// Decision log: what the core recommended, for which scan generation, and
// why. It is written once per generation by the market-signals cache and
// read by the review page. When the same generation is recomputed, the
// prior rows are replaced, so the log is idempotent rather than additive.
import { prisma } from "@/lib/prisma";
import type { MarketBundle } from "@/lib/market-signals";

export async function recordDecisions(bundle: MarketBundle): Promise<void> {
  // A decision belongs to a market; without a scope there is no market to
  // record it against, so an empty bundle never writes a row.
  const scope = bundle.scope;
  if (!bundle.latestSnapshotAt || !scope) return;
  const at = bundle.latestSnapshotAt;
  const rows = bundle.evaluation.actions.slice(0, 12).map((action) => ({
    at,
    marketId: scope.id,
    phase: bundle.phase,
    itemId: action.itemId,
    kind: action.kind,
    reason: action.reason
  }));
  await prisma.$transaction([
    prisma.decision.deleteMany({ where: { at, marketId: scope.id } }),
    ...(rows.length > 0 ? [prisma.decision.createMany({ data: rows })] : [])
  ]);
}
