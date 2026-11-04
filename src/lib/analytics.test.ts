import { describe, expect, it } from "vitest";
import { buildMarketSignal, buildWeekdaySeasonality } from "@/lib/analytics";
import type { MarketHistory } from "@/lib/market-data";
import { buildPriceIndex } from "@/lib/deflator";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-24T12:00:00Z");

function history(
  snapshots: Array<{
    daysAgo: number;
    sellPrice: number;
    marketPrice?: number;
    minPrice?: number;
    quantity?: number;
    numAuctions?: number;
    sellerCount?: number;
    bidOnly?: number;
  }>,
  overrides?: { vendorPrice?: number; itemId?: number; name?: string }
): MarketHistory {
  return {
    itemId: overrides?.itemId ?? 2770,
    name: overrides?.name ?? "铜矿石",
    quality: "common",
    category: "Trade Goods",
    subCategory: "采矿",
    vendorPrice: overrides?.vendorPrice ?? 0,
    snapshots: snapshots.map((snap) => ({
      timestamp: new Date(now.getTime() - snap.daysAgo * DAY),
      minPrice: snap.minPrice ?? Math.round(snap.sellPrice * 0.9),
      marketPrice: snap.marketPrice ?? snap.sellPrice,
      sellPrice: snap.sellPrice,
      p5Price: Math.round(snap.sellPrice * 0.92),
      quantity: snap.quantity ?? 100,
      numAuctions: snap.numAuctions ?? 10,
      sellerCount: snap.sellerCount ?? 3,
      bidOnlyCount: snap.bidOnly ?? 0,
      soldProxyLow: 0,
      soldProxyHigh: 0,
      supplyGrowth: 0,
      topTiers: [{ p: Math.round(snap.sellPrice * 0.9), q: 100 }],
      expiring: { soon: 1, mid: 1, late: 1 }
    })),
    dailySummaries: []
  };
}

describe("buildMarketSignal", () => {
  it("derives the sell front, spread, trend and supply from snapshots", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 2, sellPrice: 100 },
        { daysAgo: 1, sellPrice: 120 },
        { daysAgo: 0, sellPrice: 110, minPrice: 80, quantity: 240, numAuctions: 12, sellerCount: 5 }
      ]),
      now
    );
    expect(signal.sellPrice).toBe(110);
    expect(signal.minPrice).toBe(80);
    expect(signal.quantity).toBe(240);
    expect(signal.sellerCount).toBe(5);
    expect(signal.sellRef).toBe(110); // median of [100, 110, 120]
    expect(signal.spreadPercent).toBeCloseTo((1 - 80 / 110) * 100, 5);
    expect(signal.trendPercent).toBeCloseTo(0, 5);
    expect(signal.changePercent).toBeCloseTo(((110 - 120) / 120) * 100, 5);
  });

  it("falls back to P10 when a legacy row has no sell front", () => {
    // Rows imported before the sell-front column existed store 0, not null.
    // Treating that zero as a price would erase the item from every window.
    const signal = buildMarketSignal(
      history([{ daysAgo: 0, sellPrice: 0, marketPrice: 900, minPrice: 700 }]),
      now
    );
    expect(signal.sellPrice).toBe(900);
    expect(signal.sellRef).toBe(900);
  });

  it("counts only priced observations in the window sample size", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 3, sellPrice: 100 },
        { daysAgo: 2, sellPrice: 0 },
        { daysAgo: 0, sellPrice: 110 }
      ]),
      now
    );
    expect(signal.sellSamples).toBe(2); // the zero-priced row is not evidence
    expect(signal.sellRef).toBe(100); // lower median of [100, 110]
  });

  it("extends the reference window with daily closes beyond snapshot retention", () => {
    // The universe query only keeps the last 48 snapshots (about 12 hours
    // at the scan cadence), so a 7-day steady window could never be built
    // from snapshots alone. Older days arrive as their closing sell front;
    // the current day's close is derived from the same scans and must not
    // be counted twice.
    const item = history([
      { daysAgo: 1 / 24, sellPrice: 100 },
      { daysAgo: 2 / 24, sellPrice: 100 },
      { daysAgo: 3 / 24, sellPrice: 100 }
    ]);
    item.dailySummaries = [
      { date: new Date("2026-07-20T00:00:00Z"), openPrice: 400, closePrice: 400, highPrice: 420, lowPrice: 380, volume: 10 },
      { date: new Date("2026-07-21T00:00:00Z"), openPrice: 400, closePrice: 400, highPrice: 420, lowPrice: 380, volume: 10 },
      { date: new Date("2026-07-22T00:00:00Z"), openPrice: 400, closePrice: 400, highPrice: 420, lowPrice: 380, volume: 10 },
      { date: new Date("2026-07-23T00:00:00Z"), openPrice: 400, closePrice: 400, highPrice: 420, lowPrice: 380, volume: 10 },
      // Today's close comes from these snapshots; counting it again would
      // let one scan generation masquerade as a day of history.
      { date: new Date("2026-07-24T00:00:00Z"), openPrice: 999, closePrice: 999, highPrice: 999, lowPrice: 999, volume: 10 }
    ];
    const steady = buildMarketSignal(item, now, { phase: "steady" });
    expect(steady.sellRef).toBe(400);
    expect(steady.sellSamples).toBe(7); // 4 daily closes + 3 snapshots
    // A 6-hour wave window excludes every older daily close.
    const wave = buildMarketSignal(item, now, { phase: "wave" });
    expect(wave.sellRef).toBe(100);
    expect(wave.sellSamples).toBe(3);
  });

  it("measures spread at the current sell front, not the window reference", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 2, sellPrice: 100 },
        { daysAgo: 1, sellPrice: 100 },
        { daysAgo: 0, sellPrice: 120, minPrice: 80 }
      ]),
      now
    );
    // Lower median of [100, 100, 120] is 100, so a reference-based spread
    // would read 20%; the executable gap at today's front is 33%.
    expect(signal.sellRef).toBe(100);
    expect(signal.spreadPercent).toBeCloseTo((1 - 80 / 120) * 100, 5);
  });

  it("keeps P10 as a separate statistic, not the reference", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 2, sellPrice: 100, marketPrice: 500 },
        { daysAgo: 1, sellPrice: 120, marketPrice: 500 },
        { daysAgo: 0, sellPrice: 110, marketPrice: 500 }
      ]),
      now
    );
    expect(signal.price).toBe(500);
    expect(signal.sellRef).toBe(110);
    // The spread is measured against the sell front, never P10.
    expect(signal.spreadPercent).toBeCloseTo((1 - 99 / 110) * 100, 5);
  });

  it("ignores snapshots outside the phase window", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 20, sellPrice: 999999 },
        { daysAgo: 1, sellPrice: 100 },
        { daysAgo: 0, sellPrice: 110 }
      ]),
      now,
      { phase: "settle" } // 24-hour window
    );
    // The 20-day outlier is outside the 24h window; [100, 110] has a lower
    // median of 100.
    expect(signal.sellRef).toBe(100);
  });

  it("reports the deflated price when a price index is supplied", () => {
    const item = history([
      { daysAgo: 1, sellPrice: 100 },
      { daysAgo: 0, sellPrice: 200 }
    ]);
    const index = buildPriceIndex([item]);
    const signal = buildMarketSignal(item, now, { index });
    expect(signal.realSellPrice).not.toBeNull();
    // The index is normalised to its first day, so the second day's real
    // price is half its nominal doubling.
    expect(signal.realSellPrice!).toBeLessThan(signal.sellPrice);
  });

  it("carries demand and inferred-flow fields straight from the snapshot", () => {
    const signal = buildMarketSignal(
      history([{ daysAgo: 0, sellPrice: 100, bidOnly: 4 }]),
      now
    );
    expect(signal.bidOnlyCount).toBe(4);
    expect(signal.inferredSoldLow).toBe(0);
    expect(signal.inferredSoldHigh).toBe(0);
    expect(signal.sellersInvisible).toBe(false);
  });

  it("flags an item whose newest price row predates the current scan", () => {
    const item = history([{ daysAgo: 1, sellPrice: 100 }]);
    const scannedAt = new Date(now.getTime() - 60 * 60 * 1000);
    const signal = buildMarketSignal(item, now, { currentAt: scannedAt });
    expect(signal.stale).toBe(true);
    // Without an explicit generation the latest row is the current book.
    expect(buildMarketSignal(item, now).stale).toBe(false);
  });

  it("throws on an item with no snapshots instead of inventing a signal", () => {
    expect(() => buildMarketSignal(history([]), now)).toThrow(/no snapshots/i);
  });
});

describe("buildWeekdaySeasonality", () => {
  it("uses median closes so one spike day cannot skew a weekday", () => {
    const summaries = [
      { date: new Date("2026-07-06T00:00:00Z"), closePrice: 100, volume: 10 },
      { date: new Date("2026-07-13T00:00:00Z"), closePrice: 100, volume: 10 },
      { date: new Date("2026-07-20T00:00:00Z"), closePrice: 999999, volume: 10 },
      { date: new Date("2026-07-07T00:00:00Z"), closePrice: 200, volume: 30 }
    ];
    const seasonality = buildWeekdaySeasonality(summaries);
    const monday = seasonality.find((day) => day.weekday === 1)!;
    const tuesday = seasonality.find((day) => day.weekday === 2)!;
    expect(monday.priceDeviation).toBeCloseTo(0, 5);
    expect(tuesday.priceDeviation).toBeCloseTo(100, 5);
    expect(monday.listedShare).toBeCloseTo(50, 5);
    expect(seasonality.find((day) => day.weekday === 6)).toBeUndefined();
  });
});
