import { describe, expect, it } from "vitest";
import { bandFromInterval, fillCurve } from "@/lib/fill";

describe("fillCurve", () => {
  it("returns no points for an empty book", () => {
    expect(fillCurve([], 0.2)).toEqual([]);
  });

  it("anchors the front of the book and falls as supply sits ahead of the price", () => {
    const points = fillCurve([{ p: 100, q: 50 }, { p: 200, q: 50 }], 0.2);
    expect(points).toHaveLength(2);
    expect(points[0].price).toBe(100);
    // The cheapest tier has nothing ahead of it: the curve is anchored to
    // the core's own estimate, 1 - exp(-0.2*24).
    expect(points[0].fill).toBeCloseTo(1 - Math.exp(-4.8), 5);
    // A higher listing joins the queue behind 50 units, so it clears slower.
    const hazardBehind = 0.2 * 1 / (50 + 1);
    expect(points[1].fill).toBeCloseTo(1 - Math.exp(-hazardBehind * 24), 5);
    expect(points[1].fill).toBeLessThan(points[0].fill);
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

describe("bandFromInterval", () => {
  it("uses the wider side of the core's interval as the relative band", () => {
    expect(bandFromInterval(0.5, 0.4, 0.6)).toBeCloseTo(0.2, 6);
    expect(bandFromInterval(0.8, 0.4, 0.9)).toBeCloseTo(0.5, 6);
  });

  it("falls back to the default when the point is not an estimate", () => {
    expect(bandFromInterval(0, 0, 0)).toBe(0.35);
    expect(bandFromInterval(1, 0.5, 1)).toBeCloseTo(0.5, 6);
  });
});
