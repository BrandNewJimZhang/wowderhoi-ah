import { describe, expect, it } from "vitest";
import { designExperiment, summarizeExperiment } from "@/lib/experiments";

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

describe("summarizeExperiment", () => {
  const plan = designExperiment({ itemId: 1, sellP: 1000, inventory: 30 });

  it("summarises partial fills by price", () => {
    const summary = summarizeExperiment(plan, [
      { price: 950, qty: 10, filled: 10, timeToFillHours: 1 },
      { price: 1000, qty: 10, filled: 5, timeToFillHours: 4 },
      { price: 1050, qty: 10, filled: 0 }
    ]);
    expect(summary.fillRate).toBeCloseTo(0.5, 5);
    expect(summary.revenue).toBe(9500 + 5000);
    expect(summary.averageFillHours).toBeCloseTo((10 + 20) / 15, 5);
    expect(summary.bestPrice).toBe(950);
    expect(summary.conclusion).toContain("部分成交");
  });

  it("says demand covered the whole test when everything filled", () => {
    const summary = summarizeExperiment(plan, plan.levels.map((level) => ({ ...level, filled: level.qty, timeToFillHours: 2 })));
    expect(summary.fillRate).toBe(1);
    expect(summary.conclusion).toContain("全部成交");
  });

  it("says the price was too high when nothing filled", () => {
    const summary = summarizeExperiment(plan, plan.levels.map((level) => ({ ...level, filled: 0 })));
    expect(summary.fillRate).toBe(0);
    expect(summary.conclusion).toContain("全部未成交");
  });
});
