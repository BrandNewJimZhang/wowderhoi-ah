// The item page draws its fill curve in TypeScript while the sell plan and
// the radar use Core.fillWithin. They describe the same queue, so the chart
// must not quote a different probability for the same ladder. This test runs
// both implementations over the same books, including a duplicated price row
// and a supply-less book, and pins the point to the core's answer.
import { describe, expect, it } from "vitest";
import { fillCurve } from "@/lib/fill";
import { loadAddon } from "./wow-lua";

type Case = {
  tiers: Array<{ p: number; q: number }>;
  hazard: number;
  supply: number;
  qty: number;
  horizon: number;
};

const CASES: Case[] = [
  { tiers: [{ p: 100, q: 50 }, { p: 200, q: 50 }], hazard: 0.001, supply: 100, qty: 10, horizon: 24 },
  { tiers: [{ p: 100, q: 50 }, { p: 100, q: 50 }, { p: 300, q: 25 }], hazard: 0.002, supply: 200, qty: 5, horizon: 24 },
  { tiers: [{ p: 50, q: 10 }], hazard: 0.01, supply: 0, qty: 3, horizon: 12 }
];

describe("fill curve parity", () => {
  it("matches Core.fillWithin for every price on the ladder", () => {
    const lua = loadAddon();
    for (const testCase of CASES) {
      const points = fillCurve(
        testCase.tiers,
        testCase.hazard,
        testCase.supply,
        testCase.horizon,
        0.35,
        testCase.qty
      );
      const prices = [...new Set(testCase.tiers.map((tier) => tier.p))].sort((left, right) => left - right);
      expect(points.map((point) => point.price), JSON.stringify(testCase.tiers)).toEqual(prices);
      for (let index = 0; index < prices.length; index += 1) {
        const price = prices[index];
        const ahead = testCase.tiers
          .filter((tier) => tier.p <= price)
          .reduce((total, tier) => total + tier.q, 0);
        const expected = lua.number(
          `WowTest.ns.Core.fillWithin(${testCase.hazard}, ${testCase.supply}, ${ahead}, ${testCase.qty}, ${testCase.horizon})`
        );
        expect(points[index].fill, `price ${price}`).toBeCloseTo(expected, 9);
      }
    }
  });
});
