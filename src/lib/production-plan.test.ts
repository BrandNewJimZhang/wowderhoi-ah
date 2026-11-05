import { describe, expect, it } from "vitest";
import type { MarketSignal } from "@/lib/analytics";
import type { LpRecipe } from "@/lib/craft-lp";
import { buildProductionPlan } from "@/lib/production-plan";

function signal(overrides: Partial<MarketSignal> & { itemId: number }): MarketSignal {
  return {
    name: `Item ${overrides.itemId}`,
    category: "Trade Goods",
    quality: "common",
    sellPrice: 100,
    minPrice: 90,
    price: 95,
    quantity: 500,
    numAuctions: 10,
    sellerCount: 4,
    sellersInvisible: false,
    marketType: "commodity",
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    supplyGrowth: 0,
    vendorPrice: 0,
    stale: false,
    sellRef: 100,
    sellSamples: 10,
    spreadPercent: 10,
    trendPercent: 0,
    changePercent: 0,
    realSellPrice: null,
    ...overrides
  };
}

const RECIPE: LpRecipe = {
  id: 1,
  name: "Test Cloth",
  profession: "裁缝",
  materials: [{ itemId: 100, qty: 1 }],
  products: [{ itemId: 200, qty: 1 }]
};

describe("buildProductionPlan", () => {
  it("prices a recipe only from items that are still listed", () => {
    // The material is current, but the product left the newest scan. Its
    // last sell front is not an achievable revenue: buying materials to
    // craft something nobody is listing is how a stale price invents profit.
    const signalRows = [
      signal({ itemId: 100, sellPrice: 100 }),
      signal({ itemId: 200, sellPrice: 1000, stale: true })
    ];
    const { solution } = buildProductionPlan(signalRows, [RECIPE]);
    expect(solution.rows).toHaveLength(0);
    expect(solution.excluded).toBe(1);
  });

  it("plans nothing against an empty purse", () => {
    // Same rule as the shared core: 0 copper is what the scan saw, not
    // "cash unknown". Falling back to the planning budget would have the
    // terminal manufacture goods the character cannot pay for.
    const { budget } = buildProductionPlan(
      [signal({ itemId: 100 }), signal({ itemId: 200 })],
      [RECIPE],
      0
    );
    expect(budget).toBe(0);
  });

  it("caps the production budget at the scanned cash", () => {
    const { budget } = buildProductionPlan(
      [signal({ itemId: 100 }), signal({ itemId: 200 })],
      [RECIPE],
      1000
    );
    expect(budget).toBe(1000);
  });

  it("prices the same recipe when both sides are current", () => {
    const signalRows = [
      signal({ itemId: 100, sellPrice: 100 }),
      signal({ itemId: 200, sellPrice: 1000 })
    ];
    const { solution } = buildProductionPlan(signalRows, [RECIPE]);
    expect(solution.excluded).toBe(0);
    expect(solution.rows).toHaveLength(1);
    expect(solution.rows[0].unitProfit).toBeGreaterThan(0);
  });
});
