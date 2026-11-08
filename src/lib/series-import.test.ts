import { describe, expect, it } from "vitest";
import { aggregateSeriesDays, parseAddonSeries, selectSeriesBackfill } from "@/lib/series-import";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

const MARKET = { server: "TestRealm", faction: "Alliance" };

function sampleSeries(points: Array<{ t: number; min: number; sell: number; q: number; n?: number }>) {
  const arrays: Record<string, Record<string, number>> = { t: {}, min: {}, sell: {}, q: {}, n: {} };
  points.forEach((point, index) => {
    arrays.t[String(index + 1)] = point.t;
    arrays.min[String(index + 1)] = point.min;
    arrays.sell[String(index + 1)] = point.sell;
    arrays.q[String(index + 1)] = point.q;
    if (point.n !== undefined) arrays.n[String(index + 1)] = point.n;
  });
  return {
    v: SCAN_PIPELINE_VERSION,
    markets: {
      "TestRealm|Alliance": {
        firstScanAt: 1700000000,
        items: { 2589: arrays }
      }
    }
  };
}

describe("parseAddonSeries", () => {
  it("reads the parallel arrays into typed points", () => {
    const parsed = parseAddonSeries(sampleSeries([
      { t: 1700000000, min: 100, sell: 110, q: 20, n: 2 },
      { t: 1700000900, min: 120, sell: 130, q: 25, n: 3 }
    ]), MARKET);
    expect(parsed?.firstScanAt).toBe(1700000000);
    expect(parsed?.timestamps).toEqual([1700000900, 1700000000]);
    expect(parsed?.points).toEqual([
      { timestamp: 1700000000, itemId: 2589, minPrice: 100, sellPrice: 110, quantity: 20, numAuctions: 2 },
      { timestamp: 1700000900, itemId: 2589, minPrice: 120, sellPrice: 130, quantity: 25, numAuctions: 3 }
    ]);
  });

  it("treats a point written before listing counts existed as zero listings", () => {
    const parsed = parseAddonSeries(sampleSeries([{ t: 1700000000, min: 100, sell: 110, q: 20 }]), MARKET);
    expect(parsed?.points[0].numAuctions).toBe(0);
  });

  it("ignores a series from another pipeline or another market", () => {
    const raw = sampleSeries([{ t: 1700000000, min: 100, sell: 110, q: 20 }]) as Record<string, unknown>;
    expect(parseAddonSeries({ ...raw, v: SCAN_PIPELINE_VERSION - 1 }, MARKET)).toBeNull();
    expect(parseAddonSeries(raw, { server: "Other", faction: "Horde" })).toBeNull();
  });

  it("rejects arrays that disagree instead of misreading a point", () => {
    type ItemSeries = Record<string, Record<string, number>>;
    type Markets = Record<string, { items: Record<string, ItemSeries> }>;
    const raw = sampleSeries([{ t: 1700000000, min: 100, sell: 110, q: 20 }]) as Record<string, unknown>;
    const series = (raw.markets as Markets)["TestRealm|Alliance"].items[2589];
    series.sell["2"] = 120;
    expect(() => parseAddonSeries(raw, MARKET)).toThrow(/arrays disagree/i);
  });
});

describe("aggregateSeriesDays", () => {
  const day = 1700000000; // 2023-11-14T22:13:20Z
  const point = (timestamp: number, itemId: number, sellPrice: number, quantity: number) => ({
    timestamp, itemId, minPrice: sellPrice - 10, sellPrice, quantity, numAuctions: 2
  });

  it("folds a day into open, close, high, low and volume", () => {
    const [row] = aggregateSeriesDays([
      point(day, 2589, 100, 20),
      point(day + 900, 2589, 130, 30),
      point(day + 1800, 2589, 90, 40)
    ], new Date((day + 86400) * 1000));
    expect(row).toMatchObject({
      itemId: 2589,
      openPrice: 100,
      closePrice: 90,
      highPrice: 130,
      lowPrice: 90,
      volume: 40
    });
  });

  it("leaves the current scan's day to the scan's own merge", () => {
    const currentScanAt = new Date((day + 3600) * 1000);
    expect(aggregateSeriesDays([point(day, 2589, 100, 20)], currentScanAt)).toEqual([]);
  });

  it("keeps items and days separate", () => {
    const rows = aggregateSeriesDays([
      point(day, 2589, 100, 20),
      point(day, 2590, 200, 5),
      point(day + 86400, 2589, 110, 25)
    ], new Date((day + 2 * 86400) * 1000));
    expect(rows).toHaveLength(3);
  });
});

describe("selectSeriesBackfill", () => {
  const series = parseAddonSeries(sampleSeries([
    { t: 1700000000, min: 100, sell: 110, q: 20 },
    { t: 1700000900, min: 120, sell: 130, q: 25 },
    { t: 1700001800, min: 140, sell: 150, q: 30 }
  ]), MARKET)!;

  it("selects only timestamps the database does not have", () => {
    const backfill = selectSeriesBackfill(series, [1700000900], 1700001800, 16);
    expect(backfill.timestamps).toEqual([1700000000]);
    expect(backfill.points.map((point) => point.timestamp)).toEqual([1700000000]);
    expect(backfill.skipped).toBe(0);
  });

  it("never replays the current scan as history", () => {
    const backfill = selectSeriesBackfill(series, [], 1700001800, 16);
    expect(backfill.timestamps).toEqual([1700000000, 1700000900]);
  });

  it("caps the delivery and reports what stays behind", () => {
    const backfill = selectSeriesBackfill(series, [], 1700001800, 1);
    expect(backfill.timestamps).toEqual([1700000900]);
    expect(backfill.skipped).toBe(1);
  });
});
