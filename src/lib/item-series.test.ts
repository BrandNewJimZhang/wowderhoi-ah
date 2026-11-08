import { describe, expect, it } from "vitest";
import {
  arraysToSeries,
  mergeSeries,
  parseAddonSeries,
  retainSeries,
  scanSeriesPoints,
  seriesSamples,
  seriesToArrays,
  seriesToDailyBars,
  sparkSeries,
  type SeriesPoint
} from "@/lib/item-series";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";
import type { AddonScan } from "@/lib/addon-scan";

const MARKET = { server: "TestRealm", faction: "Alliance" };

type MutableSeries = {
  v: number;
  markets: Record<string, {
    firstScanAt: number;
    items: Record<string, Record<string, Record<string, number>>>;
  }>;
};
const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 2_000_000_000;

function sampleSeries(points: Array<{ t: number; min: number; sell: number; q: number; n?: number; e?: number }>) {
  const arrays: Record<string, Record<string, number>> = { t: {}, min: {}, sell: {}, q: {}, n: {}, e: {} };
  points.forEach((point, index) => {
    arrays.t[String(index + 1)] = point.t;
    arrays.min[String(index + 1)] = point.min;
    arrays.sell[String(index + 1)] = point.sell;
    arrays.q[String(index + 1)] = point.q;
    if (point.n !== undefined) arrays.n[String(index + 1)] = point.n;
    if (point.e !== undefined) arrays.e[String(index + 1)] = point.e;
  });
  return {
    v: SCAN_PIPELINE_VERSION,
    markets: { "TestRealm|Alliance": { firstScanAt: 1700000000, items: { 2589: arrays } } }
  };
}

function point(t: number, sellPrice: number, event = false): SeriesPoint {
  return { t, minPrice: sellPrice - 10, sellPrice, quantity: 20, numAuctions: 2, event };
}

describe("parseAddonSeries", () => {
  it("reads the parallel arrays into typed points, including the event flag", () => {
    const parsed = parseAddonSeries(sampleSeries([
      { t: 1_700_000_000, min: 100, sell: 110, q: 20, n: 2, e: 0 },
      { t: 1_700_000_900, min: 120, sell: 130, q: 25, n: 3, e: 1 }
    ]), MARKET);
    expect(parsed?.firstScanAt).toBe(1_700_000_000);
    expect(parsed?.points[1]).toEqual({
      itemId: 2589, t: 1_700_000_900, minPrice: 120, sellPrice: 130, quantity: 25, numAuctions: 3, event: true
    });
    expect(parsed?.timestamps).toEqual([1_700_000_900, 1_700_000_000]);
  });

  it("treats fields written before listing counts and events existed as zero", () => {
    const parsed = parseAddonSeries(sampleSeries([{ t: 1_700_000_000, min: 100, sell: 110, q: 20 }]), MARKET);
    expect(parsed?.points[0].numAuctions).toBe(0);
    expect(parsed?.points[0].event).toBe(false);
  });

  it("ignores a series from another pipeline or another market", () => {
    const raw = sampleSeries([{ t: 1_700_000_000, min: 100, sell: 110, q: 20 }]) as Record<string, unknown>;
    expect(parseAddonSeries({ ...raw, v: SCAN_PIPELINE_VERSION - 1 }, MARKET)).toBeNull();
    expect(parseAddonSeries(raw, { server: "Other", faction: "Horde" })).toBeNull();
  });

  it("rejects arrays that disagree instead of misreading a point", () => {
    const raw = sampleSeries([{ t: 1_700_000_000, min: 100, sell: 110, q: 20 }]) as unknown as MutableSeries;
    raw.markets["TestRealm|Alliance"].items["2589"].sell["2"] = 120;
    expect(() => parseAddonSeries(raw, MARKET)).toThrow(/arrays disagree/i);
  });

  it("rejects a timestamp that does not move forward", () => {
    const raw = sampleSeries([
      { t: 1_700_000_900, min: 100, sell: 110, q: 20 },
      { t: 1_700_000_900, min: 100, sell: 110, q: 20 }
    ]);
    expect(() => parseAddonSeries(raw, MARKET)).toThrow(/strictly increasing/);
  });

  it("rejects an event array that does not match the timestamps", () => {
    const raw = sampleSeries([{ t: 1_700_000_000, min: 100, sell: 110, q: 20, e: 0 }]) as unknown as MutableSeries;
    raw.markets["TestRealm|Alliance"].items["2589"].e["2"] = 1;
    expect(() => parseAddonSeries(raw, MARKET)).toThrow(/e=2/);
  });
});

describe("scanSeriesPoints", () => {
  it("turns the priced items of the current scan into one point each", () => {
    const scan = {
      scannedAt: new Date(1_700_000_000 * 1000),
      items: [
        { itemId: 1, priced: true, sellPrice: 110, minPrice: 100, quantity: 20, numAuctions: 2 },
        { itemId: 2, priced: false, sellPrice: 0, minPrice: 0, quantity: 0, numAuctions: 0 },
        { itemId: 3, priced: true, sellPrice: 0, minPrice: 0, quantity: 0, numAuctions: 0 }
      ]
    } as unknown as AddonScan;
    expect(scanSeriesPoints(scan)).toEqual([
      { itemId: 1, t: 1_700_000_000, minPrice: 100, sellPrice: 110, quantity: 20, numAuctions: 2, event: false }
    ]);
  });
});

describe("mergeSeries", () => {
  it("is idempotent and lets the incoming point win a timestamp", () => {
    const existing = [point(1000, 100), point(2000, 110)];
    const incoming = [point(2000, 120), point(3000, 130)];
    const once = mergeSeries(existing, incoming, 4000);
    const twice = mergeSeries(once, incoming, 4000);
    expect(once.map((row) => row.sellPrice)).toEqual([100, 120, 130]);
    expect(twice).toEqual(once);
  });

  it("keeps every point inside the full-resolution week", () => {
    const points = [point(NOW - 6 * DAY, 100), point(NOW - 6 * DAY + HOUR, 110), point(NOW - 6 * DAY + 2 * HOUR, 120)];
    expect(retainSeries(points, NOW)).toEqual(points);
  });

  it("folds older days to one point per hour but keeps an event", () => {
    const base = Math.floor((NOW - 10 * DAY) / HOUR) * HOUR;
    const retained = retainSeries([point(base, 100), point(base + 600, 110, true), point(base + 1200, 120)], NOW);
    expect(retained.map((row) => row.sellPrice)).toEqual([110, 120]);
  });

  it("folds a month-old day to its close", () => {
    const base = Math.floor((NOW - 60 * DAY) / DAY) * DAY;
    const retained = retainSeries([point(base, 100), point(base + 3600, 110), point(base + 7200, 120)], NOW);
    expect(retained.map((row) => row.sellPrice)).toEqual([120]);
  });

  it("folds an old week to its close", () => {
    const base = Math.floor((NOW - 200 * DAY) / (7 * DAY)) * 7 * DAY;
    const retained = retainSeries([point(base, 100), point(base + DAY, 110), point(base + 2 * DAY, 120)], NOW);
    expect(retained.map((row) => row.sellPrice)).toEqual([120]);
  });

  it("folds to the cap while keeping the first, the last and events", () => {
    const points = Array.from({ length: 100 }, (_, index) => point(NOW - 6 * DAY + index * 60, 100 + index, index === 50));
    const folded = retainSeries(points, NOW, 10);
    expect(folded.length).toBeGreaterThanOrEqual(10);
    expect(folded.length).toBeLessThan(100);
    expect(folded[0].sellPrice).toBe(100);
    expect(folded.at(-1)?.sellPrice).toBe(199);
    expect(folded.some((row) => row.event)).toBe(true);
  });
});

describe("series arrays", () => {
  it("round-trips through the stored array shape", () => {
    const points = [point(1000, 100, true), point(2000, 110)];
    expect(arraysToSeries(JSON.parse(JSON.stringify(seriesToArrays(points))))).toEqual(points);
  });

  it("rejects parallel arrays that disagree", () => {
    const arrays = seriesToArrays([point(1000, 100)]);
    expect(() => arraysToSeries({ ...arrays, sell: [] })).toThrow(/parallel/);
  });
});

describe("series statistics", () => {
  it("counts one usable sample when every retained point predates the window", () => {
    expect(seriesSamples([], NOW, 24)).toBe(0);
    expect(seriesSamples([point(NOW - 10 * DAY, 100)], NOW, 24)).toBe(1);
    expect(seriesSamples([point(NOW - 2 * HOUR, 100), point(NOW - HOUR, 110)], NOW, 24)).toBe(2);
  });

  it("builds UTC daily bars from the series", () => {
    const day = Math.floor(NOW / DAY) * DAY;
    const bars = seriesToDailyBars([
      point(day + 100, 100),
      point(day + 200, 130),
      point(day + 300, 90),
      point(day + DAY + 100, 95)
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ openPrice: 100, closePrice: 90, highPrice: 130, lowPrice: 90 });
    expect(bars[1].closePrice).toBe(95);
  });

  it("downsamples a sparkline evenly instead of taking the last window", () => {
    const points = Array.from({ length: 100 }, (_, index) => point(NOW - 100 * HOUR + index * HOUR, 100 + index));
    const spark = sparkSeries(points, 5);
    expect(spark).toHaveLength(5);
    expect(spark[0]).toBe(100);
    expect(spark.at(-1)).toBe(199);
  });
});
