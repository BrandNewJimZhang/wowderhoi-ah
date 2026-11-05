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
  const sale = (price: number, qty: number, listedHoursAgo: number, realizedHoursAgo: number) => ({
    itemId: 2589,
    price,
    qty,
    listedAt: new Date(1_700_000_000_000 - listedHoursAgo * 3_600_000),
    realizedAt: new Date(1_700_000_000_000 - realizedHoursAgo * 3_600_000),
    inferred: false
  });

  it("buckets confirmed sales by the price they were booked at", () => {
    const results = experimentResults([
      sale(1000, 2, 5, 3), // 2 hours on the book
      sale(1000, 1, 6, 4), // 2 hours
      sale(950, 3, 8, 6) // 2 hours
    ], 2589);
    expect(results[0]).toMatchObject({ price: 950, filled: 1, units: 3, medianHours: 2 });
    expect(results[1]).toMatchObject({ price: 1000, filled: 2, units: 3, medianHours: 2 });
  });

  it("does not shift a past sale onto today's suggested levels", () => {
    // The panel used to recompute the plan from the current sell front and
    // match sales against it; once the front moved, a filled level read as
    // unsold. Recovery must key on the booked price alone.
    const results = experimentResults([sale(1000, 2, 5, 3)], 2589);
    expect(results).toHaveLength(1);
    expect(results[0].price).toBe(1000);
  });

  it("ignores inferred sales and other items", () => {
    const results = experimentResults([
      { ...sale(1000, 1, 5, 3), inferred: true },
      { ...sale(1000, 1, 5, 3), itemId: 2770 }
    ], 2589);
    expect(results).toEqual([]);
  });

  it("reports no levels at all when nothing sold, never a 0% fill rate", () => {
    expect(experimentResults([], 2589)).toEqual([]);
  });
});
