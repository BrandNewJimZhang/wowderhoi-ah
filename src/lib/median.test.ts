import { describe, expect, it } from "vitest";
import { median } from "@/lib/median";

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
