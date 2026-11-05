// Allocation is the only place one purse is shared across recommendations.
// Before it lived in the core, every row saw the whole budget and the game
// panel ignored the plan entirely.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua } from "./wow-lua";

function item(itemId: number, overrides: Record<string, unknown> = {}) {
  return {
    itemId,
    name: `item-${itemId}`,
    itemClass: "Trade Goods",
    marketType: "commodity",
    vendorP: 10,
    minPrice: 700,
    sellP: 1000,
    quantity: 1000,
    numAuctions: 10,
    sellers: 4,
    tiers: [{ p: 700, q: 20 }, { p: 800, q: 100 }],
    history: { samples: 8 },
    inferredSoldLow: 50,
    inferredSoldHigh: 50,
    elapsedHours: 0.25,
    ...overrides
  };
}

function evaluate(items: Record<number, unknown>, budget: number, phase = "wave") {
  const lua = loadAddon();
  const input = {
    now: 1_700_000_000,
    phaseOverride: phase,
    market: { firstScanAt: 1_700_000_000 - 30 * 3600, items },
    capital: { cash: budget, budget },
    capacity: { bagSlots: 20, stackSize: 20 }
  };
  return lua.coreEval(input) as {
    rows: Array<{ itemId: number; execQty: number; allocQty: number; allocNet: number; ladderPrice: number; vendor: boolean; exploratory: boolean; samples: number }>;
    actions: Array<{ kind: string; itemId: number; qty: number; expectedNet: number }>;
  };
}

describe("shared capital allocation", () => {
  it("never spends more than the daily share across all rows", () => {
    const output = evaluate({ 2589: item(2589), 2592: item(2592) }, 100000);
    const spend = output.rows.reduce((sum, row) => sum + row.allocQty * row.ladderPrice, 0);
    // dailyBudget 0.5 of a 100k purse: 50k total, regardless of row count.
    expect(spend).toBeLessThanOrEqual(50000);
    expect(output.rows.every((row) => row.allocQty <= row.execQty)).toBe(true);
    expect(output.rows.some((row) => row.allocQty > 0)).toBe(true);
  });

  it("caps one item at the exposure share", () => {
    const output = evaluate({ 2589: item(2589) }, 100000);
    const row = output.rows[0];
    // maxItemExposure 0.25 of 100k = 25k; at ~700-800 a unit that is at
    // most 35 units, well below the 120-unit book depth.
    expect(row.allocQty).toBeGreaterThan(0);
    expect(row.allocQty * row.ladderPrice).toBeLessThanOrEqual(25000);
    expect(row.allocQty).toBeLessThan(row.execQty);
  });

  it("emits actions with the allocated quantity and its net", () => {
    const output = evaluate({ 2589: item(2589) }, 100000);
    const row = output.rows[0];
    const buy = output.actions.find((action) => action.kind === "buy");
    expect(buy?.itemId).toBe(row.itemId);
    expect(buy?.qty).toBe(row.allocQty);
    expect(buy?.expectedNet).toBe(row.allocNet);
  });

  it("allocates nothing when Kelly says the bet is negative", () => {
    const lua = loadAddon();
    const rows = [{ ladderPrice: 100, listP: 110, vendorP: 0, execQty: 100, fillProb: 0 }];
    lua.exec(`WowTest.allocRows = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(0);
    expect(lua.number("WowTest.allocRows[1].allocNet")).toBe(0);
  });

  it("uses the highest bid as an ignition demand nudge, not a gate", () => {
    const noBid = item(2589, { history: { samples: 0 } });
    const withBid = item(2592, { history: { samples: 0 }, bidOnly: 1, highestBid: 900 });
    const output = evaluate({ 2589: noBid, 2592: withBid }, 100000, "ignition");
    expect(output.rows[0].itemId).toBe(2592);
    expect(output.rows[0]).toMatchObject({
      fillBasis: expect.anything()
    });
    const lua = loadAddon();
    const input = {
      now: 1_700_000_000,
      phaseOverride: "ignition",
      market: { firstScanAt: 1_700_000_000 - 3600, items: { 2592: withBid } },
      capital: { cash: 100000, budget: 100000 },
      capacity: { bagSlots: 20, stackSize: 20 }
    };
    const evaluated = lua.coreEval(input) as { rows: Array<{ reason: string; demandPrior: number }> };
    expect(evaluated.rows[0].demandPrior).toBeCloseTo(1.2, 6);
    expect(evaluated.rows[0].reason).toContain("最高 900");
  });

  it("marks thin-evidence rows as exploratory for the cockpit", () => {
    // minKellySamples is 10; the row carries 8 history samples. The engine
    // decides the label so the terminal does not re-derive it from a
    // hardcoded number.
    const thin = evaluate({ 2589: item(2589) }, 100000);
    expect(thin.rows[0].samples).toBe(8);
    expect(thin.rows[0].exploratory).toBe(true);
    const thick = evaluate({ 2589: item(2589, { history: { samples: 12 } }) }, 100000);
    expect(thick.rows[0].exploratory).toBe(false);
  });

  it("shares the purse between guaranteed vendor trades", () => {
    const lua = loadAddon();
    const rows = [
      { ladderPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, execQty: 400, fillProb: 1 },
      { ladderPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, execQty: 400, fillProb: 1 }
    ];
    lua.exec(`WowTest.allocRows = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    // 50k daily share: the first row takes all 400 units (40k), the second
    // gets the 100 units that fit in the remaining 10k.
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(400);
    expect(lua.number("WowTest.allocRows[2].allocQty")).toBe(100);
  });
});
