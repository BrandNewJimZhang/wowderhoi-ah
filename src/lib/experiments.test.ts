import { describe, expect, it } from "vitest";
import { designExperiment, experimentResults } from "@/lib/experiments";

describe("designExperiment", () => {
  it("splits inventory across undercut, front and optimistic levels", () => {
    const plan = designExperiment({ itemId: 2589, sellP: 1000, inventory: 30 });
    expect(plan.levels.map((level) => level.price)).toEqual([950, 1000, 1050]);
    expect(plan.levels.map((level) => level.qty)).toEqual([10, 10, 10]);
  });

  it("distributes the remainder without over-listing the inventory", () => {
    const plan = designExperiment({ itemId: 2589, sellP: 1000, inventory: 31 });
    expect(plan.levels.reduce((sum, level) => sum + level.qty, 0)).toBe(31);
    expect(plan.levels[0].qty).toBe(11);
  });

  it("never produces a zero price", () => {
    const plan = designExperiment({ itemId: 1, sellP: 1, inventory: 3, stepPercent: 0.5 });
    expect(plan.levels.every((level) => level.price >= 1)).toBe(true);
  });
});

describe("experimentResults", () => {
  const level = (price: number, qty: number) => ({ price, qty });
  const sale = (price: number, qty: number, listedHoursAgo: number, realizedHoursAgo: number) => ({
    itemId: 2589,
    price,
    qty,
    listedAt: new Date(1_700_000_000_000 - listedHoursAgo * 3_600_000),
    realizedAt: new Date(1_700_000_000_000 - realizedHoursAgo * 3_600_000),
    inferred: false
  });

  it("pairs confirmed sales with their level and measures the wait", () => {
    const results = experimentResults([
      sale(1000, 2, 5, 3), // 2 hours on the book
      sale(1000, 1, 6, 4), // 2 hours
      sale(950, 3, 8, 6) // 2 hours
    ], 2589, [level(950, 3), level(1000, 3), level(1050, 3)]);
    expect(results[0]).toMatchObject({ price: 950, filled: 1, units: 3, medianHours: 2 });
    expect(results[1]).toMatchObject({ price: 1000, filled: 2, units: 3, medianHours: 2 });
    expect(results[2]).toMatchObject({ price: 1050, filled: 0, units: 0, medianHours: null });
  });

  it("ignores inferred sales and other items", () => {
    const results = experimentResults([
      { ...sale(1000, 1, 5, 3), inferred: true },
      { ...sale(1000, 1, 5, 3), itemId: 2770 }
    ], 2589, [level(1000, 1)]);
    expect(results[0].filled).toBe(0);
  });

  it("reports an unfilled level as no sale, never as a 0% fill rate", () => {
    const results = experimentResults([], 2589, [level(1000, 3)]);
    expect(results[0]).toMatchObject({ filled: 0, units: 0, medianHours: null });
  });
});
