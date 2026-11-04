import { describe, expect, it } from "vitest";
import { buildPriceIndex, indexFor, realPrice, utcDateKey } from "@/lib/deflator";
import type { MarketHistory } from "@/lib/market-data";

function item(itemId: number, snaps: Array<{ day: string; sell: number }>): MarketHistory {
  return {
    itemId,
    name: `Item ${itemId}`,
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    vendorPrice: 0,
    snapshots: snaps.map((snap) => ({
      timestamp: new Date(`${snap.day}T12:00:00Z`),
      minPrice: snap.sell - 10,
      marketPrice: snap.sell,
      sellPrice: snap.sell,
      quantity: 10,
      numAuctions: 2
    })),
    dailySummaries: []
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
    // Lower median of [100, 300] is 100 -> index 100. Lower median of
    // [200, 400] is 200 -> index 200.
    expect(index.values).toEqual([100, 200]);
  });

  it("keeps one observation per item per day", () => {
    const index = buildPriceIndex([
      item(1, [
        { day: "2026-07-01", sell: 100 },
        { day: "2026-07-01", sell: 1000 }
      ])
    ]);
    // The last scan of the day wins: 1000 / 1000 * 100.
    expect(index.values).toEqual([100]);
  });

  it("returns an empty index when no positive price exists", () => {
    expect(buildPriceIndex([])).toEqual({ dates: [], values: [], baseDate: "" });
  });

  it("uses daily closes so the index spans more than the snapshot window", () => {
    // The universe query keeps only the last 48 snapshots, so a snapshot-only
    // index can never cover two days at the 15-minute cadence. Daily closes
    // are the multi-day record, and the latest snapshot refines today.
    const history = item(1, [{ day: "2026-07-03", sell: 300 }]);
    history.dailySummaries = [
      { date: new Date("2026-07-01T00:00:00Z"), openPrice: 100, closePrice: 100, highPrice: 100, lowPrice: 100, volume: 10 },
      { date: new Date("2026-07-02T00:00:00Z"), openPrice: 100, closePrice: 200, highPrice: 200, lowPrice: 100, volume: 10 },
      { date: new Date("2026-07-03T00:00:00Z"), openPrice: 200, closePrice: 500, highPrice: 500, lowPrice: 200, volume: 10 }
    ];
    const index = buildPriceIndex([history]);
    expect(index.dates).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    // 2026-07-03 closes at 500 in the summary but the day's last snapshot is
    // 300, which wins as the most recent observation.
    expect(index.values).toEqual([100, 200, 300]);
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
