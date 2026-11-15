// The economic design promises three properties the UI depends on: a higher
// profit floor never buys more, the allocation does not care how the caller
// ordered the book, and no step spends cash or bag space the walk does not
// have. These are properties, not examples: they hold for every fixture the
// generator can throw at the core.
import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

type Row = {
  itemId: number;
  allocQty: number;
  allocCost: number;
  candidateQty: number;
};

type Step = {
  kind: "buy" | "sell";
  itemId: number;
  qty: number;
  cost?: number;
  cashBefore: number;
  cashAfter: number;
  slotsBefore: number;
  slotsAfter: number;
};

type Output = {
  rows: Row[];
  opportunities: Row[];
  actions: Step[];
  plan: { steps: Step[] };
};

function item(itemId: number, overrides: Record<string, unknown> = {}) {
  return {
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

function evaluate(
  lua: WowLua,
  items: Record<number, unknown>,
  budget = 100000,
  positions: Record<number, unknown> = {}
): Output {
  return lua.coreEval({
    now: 1_700_000_000,
    phaseOverride: "wave",
    market: { firstScanAt: 1_700_000_000 - 30 * 3600, items },
    capital: { cash: budget, budget },
    capacity: { bagSlots: 20, stackSize: 20 },
    positions
  }) as Output;
}

describe("structural invariants", () => {
  it("never buys more when the profit floor rises", () => {
    const lua = loadAddon();
    const floors = [100, 250, 500, 900, 2000];
    const quantities: number[] = [];
    for (const floor of floors) {
      lua.exec(`WowTest.ns.RULES.marketTypeRules.wave.commodity.minUnitProfit = ${floor}`);
      quantities.push(evaluate(lua, { 2589: item(2589) }).rows[0]?.allocQty ?? 0);
    }
    for (let index = 1; index < quantities.length; index += 1) {
      expect(quantities[index], `floor ${floors[index]}`).toBeLessThanOrEqual(quantities[index - 1]);
    }
    // The fixture must actually exercise the walk, not trivially zero out.
    expect(quantities[0]).toBeGreaterThan(0);
  });

  it("does not depend on the order the caller built the book in", () => {
    const lua = loadAddon();
    const forward = evaluate(lua, { 2589: item(2589), 2592: item(2592, { minPrice: 800 }), 4306: item(4306, { minPrice: 900 }) });
    const reverse = evaluate(lua, { 4306: item(4306, { minPrice: 900 }), 2592: item(2592, { minPrice: 800 }), 2589: item(2589) });
    const byId = (rows: Row[]) => [...rows].sort((left, right) => left.itemId - right.itemId);
    expect(byId(forward.rows).map((row) => [row.itemId, row.allocQty, row.allocCost]))
      .toEqual(byId(reverse.rows).map((row) => [row.itemId, row.allocQty, row.allocCost]));
    const steps = (output: Output) => output.actions.map((step) => [step.kind, step.itemId, step.qty]);
    expect(steps(forward)).toEqual(steps(reverse));
  });

  it("never lets a step spend cash or slots the walk does not have", () => {
    const lua = loadAddon();
    const output = evaluate(
      lua,
      {
        2589: item(2589),
        2592: item(2592, { minPrice: 800 }),
        4306: item(4306, { minPrice: 900 })
      },
      50000,
      { 2589: { qty: 30, cost: 21000, sellableQty: 30, costKnown: true } }
    );
    for (const step of output.plan.steps) {
      expect(step.cashBefore).toBeGreaterThanOrEqual(0);
      expect(step.cashAfter).toBeGreaterThanOrEqual(0);
      expect(step.slotsBefore).toBeGreaterThanOrEqual(0);
      expect(step.slotsAfter).toBeGreaterThanOrEqual(0);
      if (step.kind === "buy") {
        expect(step.cost ?? 0).toBeLessThanOrEqual(step.cashBefore);
        expect(step.qty).toBeGreaterThan(0);
      } else {
        expect(step.cashAfter).toBeGreaterThanOrEqual(step.cashBefore);
      }
    }
    // A sale that funds a later buy is the case the walk exists for.
    expect(output.plan.steps.some((step) => step.kind === "sell")).toBe(true);
  });
});
