import { describe, expect, it } from "vitest";
import { computeCraftProfits, type CraftRecipe } from "@/lib/crafting";

const boltRecipe: CraftRecipe = {
  name: "灵纹布卷",
  productItemId: 21840,
  productQuantity: 1,
  profession: "裁缝",
  materials: [{ itemId: 21877, name: "灵纹布", quantity: 5 }]
};

const potionRecipe: CraftRecipe = {
  name: "特效法力药水",
  productItemId: 22832,
  productQuantity: 1,
  profession: "炼金",
  materials: [
    { itemId: 22786, name: "梦露花", quantity: 2 },
    { itemId: 18256, name: "注魔之瓶", quantity: 1, vendorPriceCopper: 4000 }
  ]
};

describe("computeCraftProfits", () => {
  it("computes cost, revenue after AH cut, profit, and margin", () => {
    const prices = new Map([
      [21877, 1000], // cloth
      [21840, 8000] // bolt
    ]);
    const [row] = computeCraftProfits([boltRecipe], prices);
    expect(row.status).toBe("ok");
    expect(row.cost).toBe(5000);
    expect(row.revenue).toBe(7600); // 8000 * 0.95
    expect(row.profit).toBe(2600);
    expect(row.marginPercent).toBeCloseTo(52, 0);
  });

  it("falls back to vendor price for vendor-bought materials", () => {
    const prices = new Map([
      [22786, 3000],
      [22832, 15000]
    ]);
    const [row] = computeCraftProfits([potionRecipe], prices);
    expect(row.status).toBe("ok");
    expect(row.cost).toBe(10000); // 2*3000 + 4000 vendor
  });

  it("marks recipes with missing prices instead of fabricating numbers", () => {
    const prices = new Map([[22832, 15000]]); // product known, mat missing
    const [row] = computeCraftProfits([potionRecipe], prices);
    expect(row.status).toBe("missing");
    expect(row.missing).toEqual(["梦露花"]);
    expect(row.profit).toBe(0);
  });

  it("marks recipes whose product has no price", () => {
    const prices = new Map([[21877, 1000]]);
    const [row] = computeCraftProfits([boltRecipe], prices);
    expect(row.status).toBe("missing");
    expect(row.missing).toContain("灵纹布卷");
  });

  it("sorts ok rows by profit descending before missing rows", () => {
    const prices = new Map([
      [21877, 1000],
      [21840, 8000]
    ]);
    const rows = computeCraftProfits([potionRecipe, boltRecipe], prices);
    expect(rows[0].recipe.name).toBe("灵纹布卷");
    expect(rows[1].status).toBe("missing");
  });
});
