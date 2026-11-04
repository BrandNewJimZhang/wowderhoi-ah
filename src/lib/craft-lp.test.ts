import { describe, expect, it } from "vitest";
import { simplex, solveProduction, type LpRecipe } from "@/lib/craft-lp";

const RECIPE = (overrides: Partial<LpRecipe> & Pick<LpRecipe, "id" | "name" | "profession">): LpRecipe => ({
  materials: [],
  products: [],
  ...overrides
});

const prices = new Map<number, number>([[1, 10], [10, 100], [11, 60]]);

describe("simplex", () => {
  it("solves a one-constraint knapsack", () => {
    const solved = simplex([[2], [1]], [3, 10], [75]);
    expect(solved).not.toBeNull();
    expect(solved!.x[0]).toBeCloseTo(1.5, 5);
  });

  it("reports an unbounded problem instead of inventing a bound", () => {
    expect(simplex([[-1]], [1], [1])).toBeNull();
  });
});

describe("solveProduction", () => {
  it("picks the higher profit per limited craft slot", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "High", profession: "裁缝", materials: [{ itemId: 1, qty: 2 }], products: [{ itemId: 10, qty: 1 }] }),
      RECIPE({ id: 2, name: "Low", profession: "裁缝", materials: [{ itemId: 1, qty: 1 }], products: [{ itemId: 11, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 1 }, feeRate: 0.05 });
    expect(solution.method).toBe("lp");
    expect(solution.rows).toHaveLength(1);
    expect(solution.rows[0].recipe.name).toBe("High");
    expect(solution.rows[0].volume).toBe(1);
    expect(solution.rows[0].totalProfit).toBe(75);
    expect(solution.shadowPrices["profession:裁缝"]).toBe(75);
  });

  it("binds a material supply constraint and prices it", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "Ore", profession: "锻造", materials: [{ itemId: 1, qty: 2 }], products: [{ itemId: 10, qty: 1 }] })
    ], {
      prices,
      capacity: { 锻造: 10 },
      materialSupply: new Map([[1, 3]]),
      feeRate: 0.05
    });
    expect(solution.rows[0].volume).toBe(1); // floor(3 / 2)
    expect(solution.rows[0].totalProfit).toBe(75);
    expect(solution.shadowPrices["material:1"]).toBeCloseTo(37.5, 5);
  });

  it("excludes recipes with a missing price and says how many", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "Known", profession: "裁缝", materials: [{ itemId: 1, qty: 2 }], products: [{ itemId: 10, qty: 1 }] }),
      RECIPE({ id: 2, name: "Unknown", profession: "裁缝", materials: [{ itemId: 999, qty: 2 }], products: [{ itemId: 10, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 1 }, feeRate: 0.05 });
    expect(solution.excluded).toBe(1);
    expect(solution.rows.map((row) => row.recipe.name)).toEqual(["Known"]);
  });

  it("charges the auction fee on the product side", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "Fee", profession: "裁缝", materials: [{ itemId: 1, qty: 1 }], products: [{ itemId: 10, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 1 }, feeRate: 0.05 });
    expect(solution.rows[0].unitRevenue).toBe(95);
    expect(solution.rows[0].unitCost).toBe(10);
    expect(solution.rows[0].unitProfit).toBe(85);
  });

  it("respects a budget constraint", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "Budget", profession: "裁缝", materials: [{ itemId: 1, qty: 2 }], products: [{ itemId: 10, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 10 }, budget: 30, feeRate: 0.05 });
    expect(solution.rows[0].volume).toBe(1);
    expect(solution.shadowPrices.budget).toBeCloseTo(3.75, 5);
  });

  it("falls back to a labelled greedy allocation when the LP is unavailable", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "A", profession: "裁缝", materials: [{ itemId: 1, qty: 1 }], products: [{ itemId: 10, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 2 }, feeRate: 0.05, preferGreedy: true });
    expect(solution.method).toBe("greedy");
    expect(solution.rows[0].volume).toBe(2);
    expect(solution.shadowPrices["profession:裁缝"]).toBe(0);
  });

  it("returns nothing when no recipe is profitable", () => {
    const solution = solveProduction([
      RECIPE({ id: 1, name: "Loss", profession: "裁缝", materials: [{ itemId: 10, qty: 1 }], products: [{ itemId: 1, qty: 1 }] })
    ], { prices, capacity: { 裁缝: 10 }, feeRate: 0.05 });
    expect(solution.rows).toEqual([]);
    expect(solution.totalProfit).toBe(0);
  });
});
