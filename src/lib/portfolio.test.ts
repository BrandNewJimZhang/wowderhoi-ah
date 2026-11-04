import { describe, expect, it } from "vitest";
import { allocateCapital, kellyFraction, sizePosition, type SizingConfig } from "@/lib/portfolio";

const config: SizingConfig = {
  kappa: 0.25,
  maxItemExposure: 0.25,
  dailyBudget: 0.5,
  minSamplesForKelly: 10
};

describe("kellyFraction", () => {
  it("sizes a positive edge", () => {
    // p=0.6, odds=2 -> 0.6 - 0.4/2 = 0.4
    expect(kellyFraction(0.6, 100, 50)).toBeCloseTo(0.4, 5);
  });

  it("returns zero when the edge is negative", () => {
    expect(kellyFraction(0.3, 10, 100)).toBe(0);
  });
});

describe("sizePosition", () => {
  const opportunity = {
    itemId: 1, name: "Linen", unitCost: 1000, sellPrice: 1500,
    feeRate: 0.05, fillProb: 0.9, residualValue: 0, samples: 20
  };

  it("sizes with fractional Kelly and floors to whole units", () => {
    const sized = sizePosition(opportunity, 100000, config);
    // win 425, loss 1000, full Kelly 0.665, quarter Kelly 0.166,
    // budget 16600 -> 16 units.
    expect(sized.qty).toBe(16);
    expect(sized.budget).toBe(16000);
    expect(sized.exploratory).toBe(false);
  });

  it("caps a large edge at the per-item exposure limit", () => {
    const sized = sizePosition({ ...opportunity, fillProb: 0.99, sellPrice: 3000 }, 100000, { ...config, kappa: 1 });
    expect(sized.qty).toBe(25);
    expect(sized.cappedBy).toBe("item-exposure");
  });

  it("marks a position exploratory when the sample floor is not met", () => {
    const sized = sizePosition({ ...opportunity, samples: 2 }, 100000, config);
    expect(sized.exploratory).toBe(true);
  });

  it("does not size when the available capital is zero", () => {
    expect(sizePosition(opportunity, 0, config).qty).toBe(0);
  });
});

describe("allocateCapital", () => {
  it("allocates the daily budget to the higher expected edge first", () => {
    const allocations = allocateCapital([
      { itemId: 1, name: "A", unitCost: 1000, sellPrice: 1500, feeRate: 0.05, fillProb: 0.9, residualValue: 0, samples: 20 },
      { itemId: 2, name: "B", unitCost: 1000, sellPrice: 1200, feeRate: 0.05, fillProb: 0.9, residualValue: 0, samples: 20 }
    ], 100000, config);
    expect(allocations[0].itemId).toBe(1);
    expect(allocations.reduce((sum, row) => sum + row.budget, 0)).toBeLessThanOrEqual(50000);
  });

  it("stops when the daily budget is exhausted", () => {
    const allocations = allocateCapital([
      { itemId: 1, name: "A", unitCost: 1000, sellPrice: 3000, feeRate: 0.05, fillProb: 0.99, residualValue: 0, samples: 20 },
      { itemId: 2, name: "B", unitCost: 1000, sellPrice: 3000, feeRate: 0.05, fillProb: 0.99, residualValue: 0, samples: 20 }
    ], 100000, { ...config, kappa: 1, maxItemExposure: 1, dailyBudget: 0.3 });
    expect(allocations.reduce((sum, row) => sum + row.budget, 0)).toBeLessThanOrEqual(30000);
  });
});
