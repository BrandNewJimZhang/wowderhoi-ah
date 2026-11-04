import { describe, expect, it } from "vitest";
import { runCore } from "@/lib/core/run-core";
import { CORE_NOW, commodityInput } from "@/lib/core/fixtures";
import type { CoreInput } from "@/lib/core/types";

describe("Core.evaluate through fengari", () => {
  it("accepts a deep commodity book with a wide spread and prices the ladder", () => {
    const output = runCore(commodityInput({ phase: "wave" }));
    expect(output.phase).toBe("wave");
    expect(output.rows).toHaveLength(1);
    const row = output.rows[0];
    expect(row.execQty).toBe(120); // 20 @ 700 + 100 @ 800, both under the cap
    expect(row.ladderPrice).toBeCloseTo(783.33, 1);
    expect(row.listP).toBe(999);
    expect(row.spreadPercent).toBeCloseTo((1100 - 700) / 1100 * 100, 4);
    expect(row.netProfit).toBe(19886); // 120 * 999 * 0.95 - 94000
    expect(row.confidence).toBe("medium");
    expect(row.vendor).toBe(false);
  });

  it("puts vendor arbitrage first, with instant execution and no market gates", () => {
    const output = runCore(commodityInput({
      items: {
        2589: {
          itemId: 2589,
          name: "亚麻布",
          itemClass: "Trade Goods",
          vendorP: 100,
          minPrice: 50,
          sellP: 60,
          quantity: 100,
          numAuctions: 1,
          sellers: 1,
          tiers: [{ p: 50, q: 100 }]
        },
        2592: {
          itemId: 2592,
          name: "毛料",
          itemClass: "Trade Goods",
          vendorP: 0,
          minPrice: 700,
          sellP: 1000,
          quantity: 1000,
          numAuctions: 10,
          sellers: 4,
          tiers: [{ p: 700, q: 20 }, { p: 800, q: 100 }],
          history: { sellRef: 1100, samples: 8 }
        }
      }
    }));
    expect(output.rows.map((row) => row.itemId)).toEqual([2589, 2592]);
    expect(output.rows[0].vendor).toBe(true);
    expect(output.rows[0].netProfit).toBe(5000);
    expect(output.rows[0].fillProb).toBe(1);
  });

  it("ignition admits a spread with no history at all", () => {
    const input = commodityInput({ ageHours: 1 });
    input.market.items[2589].history = { samples: 0 };
    const output = runCore(input);
    expect(output.phase).toBe("ignition");
    expect(output.rows).toHaveLength(1);
    expect(output.rows[0].confidence).toBe("medium"); // sellers 4, depth 120
  });

  it("rejects a spread past the phase cap instead of calling it a deal", () => {
    const input = commodityInput({ phase: "wave" });
    input.market.items[2589].minPrice = 50; // 95% below the reference
    const output = runCore(input);
    expect(output.phase).toBe("wave");
    expect(output.rows).toHaveLength(0);
    expect(output.diagnostics.excluded.spread).toBe(1);
  });

  it("requires the phase's history depth outside ignition", () => {
    const input = commodityInput({ phase: "wave" });
    input.market.items[2589].history = { sellRef: 1100, samples: 2 };
    const output = runCore(input);
    expect(output.rows).toHaveLength(0);
    expect(output.diagnostics.excluded.noHistory).toBe(1);
  });

  it("caps the executable quantity by the budget, not by the whole book", () => {
    const output = runCore(commodityInput({ phase: "wave", budget: 50000 }));
    const row = output.rows[0];
    // 20 @ 700 = 14000 leaves 36000; 45 @ 800 = 36000 fits, 46 would not.
    expect(row.execQty).toBe(65);
    expect(row.ladderPrice).toBeCloseTo((20 * 700 + 45 * 800) / 65, 4);
    expect(row.netProfit).toBe(11688);
  });

  it("emits a conditional buy plan and a sell plan for a held position", () => {
    const input = commodityInput({ phase: "wave" });
    input.positions = { 2589: { qty: 40, cost: 32000 } };
    const output = runCore(input);
    const buy = output.actions.find((action) => action.kind === "buy");
    const sell = output.actions.find((action) => action.kind === "sell");
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(buy && buy.kind === "buy" && buy.stop?.ifPriceAbove).toBeGreaterThan(0);
    expect(sell && sell.kind === "sell" && sell.price).toBe(999);
  });

  it("does not let a bid-only item enter the pricing book", () => {
    const input = commodityInput({ phase: "wave" });
    input.market.items[999] = {
      itemId: 999,
      name: "Only Bids",
      itemClass: "Armor",
      minPrice: 0,
      tiers: [],
      bidOnly: 4
    } as unknown as CoreInput["market"]["items"][number];
    const output = runCore(input);
    expect(output.rows.map((row) => row.itemId)).toEqual([2589]);
  });
});
