// The plan layer is a resource-feasible sequence, not a ranked list. These
// tests check the three contracts the old actions array could not express:
// bag space is shared, sale proceeds fund later buys, and the order does not
// depend on sunk cost.
import { describe, expect, it } from "vitest";
import { runCore } from "@/lib/core/run-core";
import { commodityInput } from "@/lib/core/fixtures";

function twoItemInput() {
  const input = commodityInput({ phase: "wave", bagSlots: 1 });
  input.market.items[2592] = {
    ...input.market.items[2589],
    name: "毛料",
    minPrice: 720,
    sellP: 1020,
    tiers: [{ p: 720, q: 20 }, { p: 820, q: 100 }]
  };
  return input;
}

describe("executable plan", () => {
  it("never allocates more bag units than the free slots hold", () => {
    const output = runCore(twoItemInput());
    const bought = output.plan!.steps
      .filter((step) => step.kind === "buy")
      .reduce((sum, step) => sum + step.qty, 0);
    // One free slot at stack size 20.
    expect(bought).toBeLessThanOrEqual(20);
    expect(output.plan!.resources.slotsAfter).toBeLessThanOrEqual(1);
  });

  it("starts each step from the previous step's cash and slots", () => {
    const output = runCore(twoItemInput());
    let cash = output.plan!.resources.cashBefore;
    let slots = output.plan!.resources.slotsBefore;
    for (const step of output.plan!.steps) {
      expect(step.cashBefore).toBe(cash);
      expect(step.slotsBefore).toBe(slots);
      cash = step.cashAfter!;
      slots = step.slotsAfter!;
    }
    expect(output.plan!.resources.cashAfter).toBe(cash);
  });

  it("promotes a sale to fund a buy when the purse is empty", () => {
    const input = commodityInput({ phase: "wave", budget: 0 });
    input.capital = { cash: 0, budget: 0 };
    input.positions = { 2589: { qty: 60, cost: 12000, sellableQty: 60 } };
    const output = runCore(input);
    const sellIndex = output.plan!.steps.findIndex((step) => step.kind === "sell");
    const buyIndex = output.plan!.steps.findIndex((step) => step.kind === "buy");
    expect(sellIndex).toBe(0);
    expect(buyIndex).toBeGreaterThan(0);
    expect(output.plan!.steps[buyIndex].cashBefore).toBe(output.plan!.steps[0].cashAfter);
    expect(output.plan!.steps[0].cashBefore).toBe(0);
  });

  it("orders sells by proceeds per minute, not by historical cost", () => {
    const cheap = commodityInput({ phase: "wave" });
    cheap.positions = { 2589: { qty: 40, cost: 8000, sellableQty: 40 } };
    const expensive = commodityInput({ phase: "wave" });
    expensive.positions = { 2589: { qty: 40, cost: 48000, sellableQty: 40 } };
    const unknown = commodityInput({ phase: "wave" });
    unknown.positions = { 2589: { qty: 40, cost: 0, sellableQty: 40, costKnown: false } };

    const order = (input: typeof cheap) =>
      runCore(input).plan!.steps
        .filter((step) => step.kind === "sell")
        .map((step) => `${step.kind}:${step.itemId}`);
    expect(order(expensive)).toEqual(order(cheap));
    expect(order(unknown)).toEqual(order(cheap));
    // Exposure is a separate rule: a position already above the per-item
    // cap suppresses new buys, but it does not reorder the sell plan.
    expect(runCore(expensive).plan!.steps.some((step) => step.kind === "buy")).toBe(false);

    const sell = (input: typeof cheap) =>
      runCore(input).plan!.steps.find((step) => step.kind === "sell");
    expect(sell(cheap)?.expectedNet).toBe(sell(expensive)?.expectedNet);
    expect(sell(cheap)?.realizedPnl).toBeGreaterThan(sell(expensive)!.realizedPnl as number);
    expect(sell(unknown)?.costKnown).toBe(false);
    expect(sell(unknown)?.realizedPnl).toBeUndefined();
  });

  it("keeps unaffordable candidates with an explicit reason", () => {
    const input = twoItemInput();
    input.capital = { cash: 100000, budget: 100000 };
    input.capacity = { bagSlots: 3, freeSlots: 0, stackSize: 20 };
    const output = runCore(input);
    const reasons = output.plan!.unplanned.map((row) => row.reason);
    expect(reasons).toContain("slots");
    for (const reason of reasons) expect(typeof reason).toBe("string");
  });
});
