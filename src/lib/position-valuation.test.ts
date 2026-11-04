import { describe, expect, it } from "vitest";
import { valuePositions } from "@/lib/position-valuation";

describe("valuePositions", () => {
  it("values quoted positions at the current sell front", () => {
    const valuation = valuePositions(
      { 100: { qty: 10, cost: 800 } },
      new Map([[100, 120]]),
      new Map([[100, "Linen Cloth"]])
    );
    expect(valuation.rows[0]).toMatchObject({
      name: "Linen Cloth",
      unitCost: 80,
      value: 1200,
      priced: true,
      unrealized: 400
    });
    expect(valuation.pricedValue).toBe(1200);
    expect(valuation.pricedCost).toBe(800);
    expect(valuation.unrealized).toBe(400);
    expect(valuation.unpricedCount).toBe(0);
  });

  it("keeps unpriced positions out of the totals instead of valuing them at zero", () => {
    const valuation = valuePositions(
      {
        100: { qty: 10, cost: 800 },
        200: { qty: 5, cost: 500 }
      },
      new Map([[100, 120]]),
      new Map([[100, "Linen Cloth"]])
    );
    const unpriced = valuation.rows.find((row) => row.itemId === 200);
    expect(unpriced?.priced).toBe(false);
    expect(unpriced?.price).toBe(0);
    expect(unpriced?.unrealized).toBeNull();
    // The 500 copper of committed cost is real but cannot be marked to a
    // price the market is not showing, so it never becomes a fake -500 loss.
    expect(valuation.pricedValue).toBe(1200);
    expect(valuation.pricedCost).toBe(800);
    expect(valuation.unrealized).toBe(400);
    expect(valuation.unpricedCount).toBe(1);
  });

  it("sorts priced positions first and unpriced ones by committed cost", () => {
    const valuation = valuePositions(
      {
        100: { qty: 1, cost: 100 },
        200: { qty: 1, cost: 900 },
        300: { qty: 1, cost: 50 }
      },
      new Map([[100, 200]]),
      new Map()
    );
    expect(valuation.rows.map((row) => row.itemId)).toEqual([100, 200, 300]);
  });
});
