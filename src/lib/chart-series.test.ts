import { describe, expect, it } from "vitest";
import { buildTimeSeries } from "@/lib/chart-series";

function snapshot(minute: string, price: number, min = price - 100, quantity = 50) {
  return {
    timestamp: new Date(`2026-07-20T${minute}:00Z`),
    sellPrice: price,
    marketPrice: price - 50,
    minPrice: min,
    quantity
  };
}

describe("buildTimeSeries", () => {
  it("extends the intraday window with daily closes older than the oldest snapshot", () => {
    const points = buildTimeSeries(
      [snapshot("10:00", 1000), snapshot("10:15", 1100)],
      [
        { date: new Date("2026-07-18T00:00:00Z"), closePrice: 700, lowPrice: 650, volume: 40 },
        // Same UTC day as the snapshots: its close is derived from these
        // scans, so including it would plot the same day twice.
        { date: new Date("2026-07-20T00:00:00Z"), closePrice: 1234, lowPrice: 1200, volume: 99 }
      ]
    );
    expect(points.map((point) => point.price)).toEqual([700, 1000, 1100]);
    expect(points[0]).toEqual({
      ts: new Date("2026-07-18T00:00:00Z").getTime(),
      price: 700,
      min: 650,
      volume: 40
    });
  });

  it("drops daily closes without a usable price", () => {
    const points = buildTimeSeries(
      [snapshot("10:00", 1000)],
      [
        { date: new Date("2026-07-18T00:00:00Z"), closePrice: 0, lowPrice: 0, volume: 0 },
        { date: new Date("2026-07-17T00:00:00Z"), closePrice: 800, lowPrice: 750, volume: 10 }
      ]
    );
    expect(points.map((point) => point.price)).toEqual([800, 1000]);
  });

  it("falls back to the P10 price for legacy rows without a sell front", () => {
    const points = buildTimeSeries([{
      timestamp: new Date("2026-07-20T10:00:00Z"),
      sellPrice: 0,
      marketPrice: 900,
      minPrice: 800,
      quantity: 50
    }], []);
    expect(points).toHaveLength(1);
    expect(points[0].price).toBe(900);
  });
});
