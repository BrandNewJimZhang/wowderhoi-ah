import { describe, expect, it } from "vitest";
import { buildTimeSeries, withGapBreaks, type TimePoint } from "@/lib/chart-series";

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
      volume: 40,
      kind: "daily"
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

  it("measures gaps from the scan cadence, not the mixed series", () => {
    const day = 24 * 60 * 60 * 1000;
    const minute = 60 * 1000;
    const start = new Date("2026-07-20T10:00:00Z").getTime();
    const points: TimePoint[] = [
      { ts: start, price: 700, kind: "daily" },
      { ts: start + day, price: 800, kind: "daily" },
      // The live segment: two scans 15 minutes apart, then a two-hour
      // outage.
      { ts: start + day + minute * 15, price: 900, kind: "scan" },
      { ts: start + day + minute * 30, price: 950, kind: "scan" },
      { ts: start + day + minute * 150, price: 1000, kind: "scan" }
    ];
    const plotted = withGapBreaks(points);
    // Consecutive daily closes are not a scanning outage, and they must not
    // be used to derive the cadence.
    expect(plotted.filter((point) => point.gap)).toHaveLength(1);
    expect(plotted.find((point) => point.gap)?.ts).toBe(start + day + minute * 30 + 1);
  });

  it("connects a daily close to the first intraday scan", () => {
    const day = 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    const daily = new Date("2026-07-19T00:00:00Z").getTime();
    // Daily closes carry a midnight timestamp while scans carry the wall
    // clock of the first import, so the junction can be nearly two days
    // wide. That is a resolution change, not a scanning outage.
    const plotted = withGapBreaks([
      { ts: daily, price: 700, kind: "daily" },
      { ts: daily + day + hour * 22, price: 900, kind: "scan" },
      { ts: daily + day + hour * 22 + 15 * 60 * 1000, price: 950, kind: "scan" }
    ]);
    expect(plotted.filter((point) => point.gap)).toHaveLength(0);
  });

  it("breaks when the live scans are days after the last daily close", () => {
    const day = 24 * 60 * 60 * 1000;
    const daily = new Date("2026-07-14T00:00:00Z").getTime();
    const plotted = withGapBreaks([
      { ts: daily, price: 700, kind: "daily" },
      { ts: daily + day * 6, price: 900, kind: "scan" },
      { ts: daily + day * 6 + 15 * 60 * 1000, price: 950, kind: "scan" }
    ]);
    expect(plotted.filter((point) => point.gap)).toHaveLength(1);
  });

  it("breaks a series where a day is missing between daily closes", () => {
    const day = 24 * 60 * 60 * 1000;
    const start = new Date("2026-07-16T00:00:00Z").getTime();
    const plotted = withGapBreaks([
      { ts: start, price: 700, kind: "daily" },
      { ts: start + day, price: 720, kind: "daily" },
      // July 19 is missing: the market was not scanned that day.
      { ts: start + day * 3, price: 800, kind: "daily" }
    ]);
    expect(plotted.filter((point) => point.gap)).toHaveLength(1);
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
