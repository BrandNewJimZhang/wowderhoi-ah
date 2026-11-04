// One production-plan builder for every surface that shows manufacturing:
// the cockpit summary and the full /recipes page must price the same
// recipes against the same sells, capacity and budget. The LP itself lives
// in craft-lp.ts; this only assembles its inputs from terminal data.
import type { MarketSignal } from "@/lib/analytics";
import { solveProduction, type LpRecipe, type ProductionSolution } from "@/lib/craft-lp";
import { resolveBudgetCopper } from "@/lib/config";
import { productionCapacity, productionDefaults } from "@/lib/production-config";

export function buildProductionPlan(
  signals: MarketSignal[],
  recipes: LpRecipe[],
  cashCopper = 0
): { solution: ProductionSolution; budget: number } {
  // A delisted item has no buyable materials and no sellable product: its
  // last sell front is history, not an achievable price. Pricing a recipe
  // from it would manufacture profit the market cannot pay.
  const current = signals.filter((signal) => !signal.stale);
  const prices = new Map(current.map((signal) => [signal.itemId, signal.sellPrice]));
  const vendorPrices = new Map(
    current.filter((signal) => signal.vendorPrice > 0).map((signal) => [signal.itemId, signal.vendorPrice])
  );
  const materialSupply = new Map(current.map((signal) => [signal.itemId, signal.quantity]));
  // Same capital base as the cockpit and the shared core: the planning
  // budget is an upper cap, never more than the scanned purse.
  const planned = resolveBudgetCopper();
  const budget = cashCopper > 0 ? Math.min(planned, cashCopper) : planned;
  const solution = solveProduction(recipes, {
    prices,
    vendorPrices,
    capacity: productionCapacity,
    materialSupply,
    budget,
    feeRate: productionDefaults.feeRate,
    maxCandidates: productionDefaults.maxCandidates
  });
  return { solution, budget };
}
