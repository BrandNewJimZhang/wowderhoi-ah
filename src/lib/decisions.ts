// Decision log: what the core recommended, for which scan generation, and
// why. It is written once per generation by the market-signals cache and
// read by the review page. When the same generation is recomputed, the
// prior rows are replaced, so the log is idempotent rather than additive.
//
// Each row also stores what the recommendation expected -- net profit,
// fill chance and the allocated quantity -- so the review page can bucket
// predictions against confirmed sales instead of only describing them.
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
    reason: action.reason,
    expectedNet: action.expectedNet,
    // A sell plan carries no market fill estimate: the goods already exist
    // and the plan prices them. Leaving the column null says so.
    fillProb: action.kind === "buy" ? action.fillProb : null,
    fillBasis: action.kind === "buy" ? action.fillBasis : null,
    allocQty: action.kind === "buy" ? action.allocQty : action.qty,
    allocUnitPrice: action.kind === "buy" ? action.allocUnitPrice : action.price
  }));
  await prisma.$transaction([
    prisma.decision.deleteMany({ where: { at, marketId: scope.id } }),
    ...(rows.length > 0 ? [prisma.decision.createMany({ data: rows })] : [])
  ]);
}
