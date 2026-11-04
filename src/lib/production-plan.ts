// One production-plan builder for every surface that shows manufacturing:
// the cockpit summary and the full /recipes page must price the same
// recipes against the same sells, capacity and budget. The LP itself lives
// in craft-lp.ts; this only assembles its inputs from terminal data.
import type { MarketSignal } from "@/lib/analytics";
import { solveProduction, type LpRecipe, type ProductionSolution } from "@/lib/craft-lp";
import { productionCapacity, productionDefaults } from "@/lib/production-config";

export function buildProductionPlan(
  signals: MarketSignal[],
  recipes: LpRecipe[]
): { solution: ProductionSolution; budget: number } {
  const prices = new Map(signals.map((signal) => [signal.itemId, signal.sellPrice]));
  const vendorPrices = new Map(
    signals.filter((signal) => signal.vendorPrice > 0).map((signal) => [signal.itemId, signal.vendorPrice])
  );
  const materialSupply = new Map(signals.map((signal) => [signal.itemId, signal.quantity]));
  const budget = Number(process.env.AQT_BUDGET_COPPER) || productionDefaults.budgetCopper;
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
