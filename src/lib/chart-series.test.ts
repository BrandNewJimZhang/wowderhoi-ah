import { describe, expect, it } from "vitest";
import { buildTimeSeries, withGapBreaks, type TimePoint } from "@/lib/chart-series";

function seriesPoint(ts: number, price: number, min = price - 100, quantity = 50) {
  return { t: Math.floor(ts / 1000), minPrice: min, sellPrice: price, quantity, numAuctions: 5, event: false };
}

describe("buildTimeSeries", () => {
  it("plots every retained series point with its sell front", () => {
    const start = new Date("2026-07-20T10:00:00Z").getTime();
    const points = buildTimeSeries([
      seriesPoint(start, 1000),
      seriesPoint(start + 15 * 60 * 1000, 1100, 900, 70)
    ]);
    expect(points).toEqual([
      { ts: start, price: 1000, min: 900, volume: 50, kind: "scan" },
      { ts: start + 15 * 60 * 1000, price: 1100, min: 900, volume: 70, kind: "scan" }
    ]);
  });

  it("drops a point without a usable price", () => {
    const start = new Date("2026-07-20T10:00:00Z").getTime();
    const points = buildTimeSeries([seriesPoint(start, 0), seriesPoint(start + 900_000, 800)]);
    expect(points.map((point) => point.price)).toEqual([800]);
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

});
