import { describe, expect, it } from "vitest";
import { buildPriceIndex, indexFor, realPrice, utcDateKey } from "@/lib/deflator";
import type { SeriesPoint } from "@/lib/item-series";

function item(itemId: number, prices: Array<{ day: string; sell: number }>) {
  return {
    itemId,
    points: prices.map((entry, index): SeriesPoint => ({
      t: Math.floor(new Date(`${entry.day}T12:00:00Z`).getTime() / 1000) + index,
      minPrice: entry.sell - 10,
      sellPrice: entry.sell,
      quantity: 10,
      numAuctions: 2,
      event: false
    }))
  };
}

describe("buildPriceIndex", () => {
  it("normalises the first day to 100 and takes the daily median", () => {
    const index = buildPriceIndex([
      item(1, [{ day: "2026-07-01", sell: 100 }, { day: "2026-07-02", sell: 200 }]),
      item(2, [{ day: "2026-07-01", sell: 300 }, { day: "2026-07-02", sell: 400 }])
    ]);
    expect(index.baseDate).toBe("2026-07-01");
    expect(index.dates).toEqual(["2026-07-01", "2026-07-02"]);
    expect(index.values).toEqual([100, 200]);
  });

  it("keeps one observation per item per day, the day's last point", () => {
    const index = buildPriceIndex([
      item(1, [
        { day: "2026-07-01", sell: 100 },
        { day: "2026-07-01", sell: 1000 }
      ])
    ]);
    expect(index.values).toEqual([100]);
  });

  it("returns an empty index when no positive price exists", () => {
    expect(buildPriceIndex([])).toEqual({ dates: [], values: [], baseDate: "" });
    expect(buildPriceIndex([{ itemId: 1, points: [] }])).toEqual({ dates: [], values: [], baseDate: "" });
  });

  it("spans every day the series covers", () => {
    const index = buildPriceIndex([
      item(1, [
        { day: "2026-07-01", sell: 100 },
        { day: "2026-07-02", sell: 200 },
        { day: "2026-07-03", sell: 500 }
      ])
    ]);
    expect(index.dates).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(index.values).toEqual([100, 200, 500]);
  });
});

describe("indexFor and realPrice", () => {
  const index = {
    dates: ["2026-07-01", "2026-07-03"],
    values: [100, 200],
    baseDate: "2026-07-01"
  };

  it("carries the last observed level forward", () => {
    expect(indexFor(index, new Date("2026-07-02T12:00:00Z"))).toBe(100);
    expect(indexFor(index, new Date("2026-07-04T12:00:00Z"))).toBe(200);
  });

  it("returns null before the first observation", () => {
    expect(indexFor(index, new Date("2026-06-30T12:00:00Z"))).toBeNull();
  });

  it("deflates a nominal price by the index", () => {
    expect(realPrice(400, new Date("2026-07-03T12:00:00Z"), index)).toBe(200);
    expect(realPrice(400, new Date("2026-06-30T12:00:00Z"), index)).toBeNull();
  });

  it("formats UTC dates", () => {
    expect(utcDateKey(new Date("2026-07-03T23:59:00Z"))).toBe("2026-07-03");
  });
});
