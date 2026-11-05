import { describe, expect, it } from "vitest";
import { bandFromInterval, fillBasisLabel, fillCurve } from "@/lib/fill";

describe("fillCurve", () => {
  it("returns no points for an empty book", () => {
    expect(fillCurve([], 0.2, 100)).toEqual([]);
  });

  it("counts same-price units as ahead of the listing", () => {
    // 50 units already sit at 100. A ten-unit listing at 100 joins behind
    // them -- same price, listed earlier -- so 60 units must clear, not ten.
    // Core.fillWithin and Core.sellPlan count the queue the same way.
    const points = fillCurve([{ p: 100, q: 50 }], 0.001, 100, 24, 0.35, 10);
    expect(points[0].fill).toBeCloseTo(1 - Math.exp((-0.001 * 100 * 24) / 60), 5);
  });

  it("anchors the front of the book and falls as supply sits ahead of the price", () => {
    const points = fillCurve([{ p: 100, q: 50 }, { p: 200, q: 50 }], 0.001, 100, 24, 0.35, 10);
    expect(points).toHaveLength(2);
    expect(points[0].price).toBe(100);
    expect(points[0].fill).toBeCloseTo(1 - Math.exp((-0.001 * 100 * 24) / 60), 5);
    // The 200-coin listing queues behind all 100 units plus its own ten.
    expect(points[1].fill).toBeCloseTo(1 - Math.exp((-0.001 * 100 * 24) / 110), 5);
    expect(points[1].fill).toBeLessThan(points[0].fill);
  });

  it("clears the same listing faster in a deeper book", () => {
    // The hazard is a share of the book per hour, so the units per hour
    // depend on how big the book is. Treating the share as a listing
    // hazard made a deep market and a thin one look identical.
    const thin = fillCurve([{ p: 100, q: 10 }], 0.001, 100, 24, 0.35, 10)[0].fill;
    const deep = fillCurve([{ p: 100, q: 10 }], 0.001, 1000, 24, 0.35, 10)[0].fill;
    expect(deep).toBeGreaterThan(thin);
  });


  it("brackets every point with a visible band", () => {
    const points = fillCurve([{ p: 100, q: 10 }], 0.001, 100, 24, 0.35, 10);
    expect(points[0].band[0]).toBeLessThan(points[0].fill);
    expect(points[0].band[1]).toBeGreaterThan(points[0].fill);
  });

  it("never leaves the 0..1 range", () => {
    const points = fillCurve([{ p: 100, q: 10 }], 100, 1000, 1000, 1, 10);
    expect(points[0].fill).toBeLessThanOrEqual(1);
    expect(points[0].band[0]).toBeGreaterThanOrEqual(0);
    expect(points[0].band[1]).toBeLessThanOrEqual(1);
  });
});

describe("fillBasisLabel", () => {
  it("names every evidence tier the core can emit", () => {
    expect(fillBasisLabel("own")).toBe("自有成交");
    expect(fillBasisLabel("observed-zero")).toBe("观测为零");
    expect(fillBasisLabel("vendor")).toBe("NPC 收购");
  });

  it("falls back to the prior tier for missing or unknown evidence", () => {
    // Core.lua resolves FILL_BASIS_TEXT the same way: an unknown tier is the
    // absence of evidence, never an untranslated string in the UI.
    expect(fillBasisLabel(null)).toBe("阶段先验");
    expect(fillBasisLabel(undefined)).toBe("阶段先验");
    expect(fillBasisLabel("some-future-tier")).toBe("阶段先验");
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
