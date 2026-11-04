import { describe, expect, it } from "vitest";
import { designExperiment } from "@/lib/experiments";

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
