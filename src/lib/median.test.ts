import { describe, expect, it } from "vitest";
import { median, quantile } from "@/lib/median";

describe("median", () => {
  it("resolves an even window to the lower middle sample", () => {
    // Core.lua's Core.median uses the same rule, so the in-game and
    // terminal references round an even window to the same observation.
    expect(median([40, 10, 30, 20])).toBe(20);
    expect(median([5])).toBe(5);
  });

  it("returns 0 for an empty window", () => {
    expect(median([])).toBe(0);
  });
});

describe("quantile", () => {
  it("keeps the median convention at the middle", () => {
    expect(quantile([40, 10, 30, 20], 0.5)).toBe(20);
  });

  it("brackets the middle with the quartiles", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3);
  });

  it("clamps an empty window and out-of-range quantiles", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([5, 6], 0)).toBe(5);
    expect(quantile([5, 6], 1)).toBe(6);
  });
});
