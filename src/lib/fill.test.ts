import { describe, expect, it } from "vitest";
import { fillCurve } from "@/lib/fill";

describe("fillCurve", () => {
  it("returns no points for an empty book", () => {
    expect(fillCurve([], 0.2)).toEqual([]);
  });

  it("rises with the share of supply ahead of the price", () => {
    const points = fillCurve([{ p: 100, q: 50 }, { p: 200, q: 50 }], 0.2);
    expect(points).toHaveLength(2);
    expect(points[0].price).toBe(100);
    expect(points[1].fill).toBeGreaterThan(points[0].fill);
    // At the top of the book the share is 100%: 1 - exp(-0.2*24).
    expect(points[1].fill).toBeCloseTo(1 - Math.exp(-4.8), 5);
  });

  it("brackets every point with a visible band", () => {
    const points = fillCurve([{ p: 100, q: 10 }], 0.2);
    expect(points[0].band[0]).toBeLessThan(points[0].fill);
    expect(points[0].band[1]).toBeGreaterThan(points[0].fill);
  });

  it("never leaves the 0..1 range", () => {
    const points = fillCurve([{ p: 100, q: 10 }], 100, 1000, 1);
    expect(points[0].fill).toBeLessThanOrEqual(1);
    expect(points[0].band[0]).toBeGreaterThanOrEqual(0);
    expect(points[0].band[1]).toBeLessThanOrEqual(1);
  });
});
