// The sell page used to post one price: the front minus a copper. The
// search picks price and duration together by expected net after fees and
// the risk of losing the deposit, and never below the NPC floor.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua } from "./wow-lua";

function plan(input: {
  hazard: number;
  deposits: Record<number, number>;
  vendorP?: number;
  supply?: number;
  cost?: number;
  tiers?: Array<{ p: number; q: number }>;
}) {
  const lua = loadAddon();
  lua.exec(`WowTest.pricingResult = WowTest.ns.Core.sellPlan(
    { itemId = 2589, sellP = 1000, vendorP = ${input.vendorP ?? 0} },
    { qty = 10, cost = ${input.cost ?? 0} },
    WowTest.ns.RULES,
    {
      deposits = { [12] = ${input.deposits[12]}, [24] = ${input.deposits[24]}, [48] = ${input.deposits[48]} },
      hazard = ${input.hazard},
      supply = ${input.supply ?? 100},
      tiers = ${toLua(input.tiers ?? [{ p: 1000, q: 100 }])}
    })`);
  return {
    price: lua.number("WowTest.pricingResult.listP"),
    duration: lua.number("WowTest.pricingResult.duration"),
    fill: lua.number("WowTest.pricingResult.fillProb"),
    optimized: lua.eval("WowTest.pricingResult.optimized"),
    lossIfExpired: lua.number("WowTest.pricingResult.lossIfExpired")
  };
}

describe("sell price and duration search", () => {
  it("takes the shortest listing when the item clears immediately", () => {
    const result = plan({ hazard: 0.5, deposits: { 12: 10, 24: 20, 48: 40 } });
    expect(result.optimized).toBe(true);
    expect(result.price).toBe(999);
    expect(result.duration).toBe(12);
    expect(result.fill).toBeGreaterThan(0.99);
  });

  it("waits longer on a slow item instead of cutting the price", () => {
    const result = plan({ hazard: 0.0001, deposits: { 12: 10, 24: 20, 48: 40 } });
    expect(result.price).toBe(999);
    expect(result.duration).toBe(48);
  });

  it("prefers a short cheap listing when the longer deposit is expensive", () => {
    const result = plan({ hazard: 0.0001, deposits: { 12: 0, 24: 10000, 48: 20000 } });
    expect(result.duration).toBe(12);
  });

  it("never recommends a price at or below the NPC floor", () => {
    const result = plan({ hazard: 0.5, deposits: { 12: 0, 24: 0, 48: 0 }, vendorP: 980 });
    expect(result.price).toBeGreaterThanOrEqual(981);
  });

  it("agrees with the radar's fill estimate at the same price", () => {
    // Both sides are given the same share, the same book and the same
    // ten-unit listing at the front. The 24-hour deposit is free and the
    // other durations are priced out, so the search must land on 24 hours
    // and its probability must equal the radar's point estimate.
    const lua = loadAddon();
    const planFill = lua.text(
      `(function()
        local plan = WowTest.ns.Core.sellPlan(
          { itemId = 2589, sellP = 1000, vendorP = 0 },
          { qty = 10, cost = 0 },
          WowTest.ns.RULES,
          {
            deposits = { [12] = 10000, [24] = 0, [48] = 10000 },
            hazard = 0.001,
            supply = 100,
            tiers = { { p = 1000, q = 100 } }
          })
        return string.format("%d|%d|%.4f", plan.listP, plan.duration, plan.fillProb)
      end)()`
    );
    const [price, duration, fillProb] = planFill.split("|");
    expect(Number(price)).toBe(999);
    expect(Number(duration)).toBe(24);
    const radar = lua.text(
      `(function()
        local _, _, point = WowTest.ns.Core.fillProbability({
          horizonHours = 24, phase = "steady", marketType = "commodity",
          qty = 10, sold = 1, supply = 100, elapsedHours = 10, ahead = 0
        })
        return string.format("%.4f", point)
      end)()`
    );
    // 0.001/hour over 100 units = 0.1 units/hour; ten units clear in 100h.
    expect(Number(radar)).toBeCloseTo(1 - Math.exp(-0.24), 4);
    expect(Number(fillProb)).toBeCloseTo(Number(radar), 4);
  });

  it("does not let the historical basis choose the listing", () => {
    // The same goods with different purchase prices face the same cash
    // trade-off. Subtracting the basis made a lot bought above the market
    // prefer the shortest listing, i.e. the one least likely to sell.
    const free = { 12: 0, 24: 0, 48: 0 };
    const cheap = plan({ hazard: 0.005, deposits: free, cost: 0 });
    const loss = plan({ hazard: 0.005, deposits: free, cost: 20000 });
    expect(loss.price).toBe(cheap.price);
    expect(loss.duration).toBe(cheap.duration);
    expect(cheap.duration).toBe(48);
    // The reported numbers still use the booked basis.
    expect(loss.lossIfExpired).toBeGreaterThan(cheap.lossIfExpired);
  });

  it("keeps the plain plan when the caller offers no market inputs", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.plainPlan = WowTest.ns.Core.sellPlan(
      { itemId = 2589, sellP = 1000, vendorP = 10 }, { qty = 10, cost = 8000 }, WowTest.ns.RULES, { deposit = 500 })`);
    expect(lua.number("WowTest.plainPlan.listP")).toBe(999);
    expect(lua.number("WowTest.plainPlan.duration")).toBe(24);
    expect(lua.eval("WowTest.plainPlan.optimized")).toBe(null);
  });
});
