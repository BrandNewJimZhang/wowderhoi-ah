import { describe, expect, it } from "vitest";
import { buildMarketSignal, buildWeekdaySeasonality, sellFrontByItem, type SignalInput } from "@/lib/analytics";
import { buildPriceIndex } from "@/lib/deflator";
import type { MarketQuote } from "@/lib/market-data";
import type { SeriesPoint } from "@/lib/item-series";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-24T12:00:00Z");

function quote(partial: Partial<MarketQuote> = {}): MarketQuote {
  const sellPrice = partial.sellPrice ?? 100;
  return {
    timestamp: now,
    priced: true,
    minPrice: partial.minPrice ?? Math.round(sellPrice * 0.9),
    marketPrice: partial.marketPrice ?? sellPrice,
    sellPrice,
    p5Price: Math.round(sellPrice * 0.92),
    quantity: 100,
    numAuctions: 10,
    sellerCount: 3,
    sellersInvisible: false,
    ownerVisible: true,
    observationVersion: 2,
    sellerHHI: null,
    topSellerShare: null,
    marketType: "commodity",
    bidOnlyCount: 0,
    highestBid: 0,
    soldProxyLow: 0,
    soldProxyHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    historySamples: null,
    historySpanHours: null,
    tierTruncated: false,
    topTiers: [{ p: Math.round(sellPrice * 0.9), q: 100 }],
    expiring: { soon: 1, mid: 1, late: 1 },
    ...partial
  };
}

function points(entries: Array<{ daysAgo: number; sellPrice: number; quantity?: number }>): SeriesPoint[] {
  return entries
    .map((entry) => ({
      t: Math.round((now.getTime() - entry.daysAgo * DAY) / 1000),
      minPrice: Math.round(entry.sellPrice * 0.9),
      sellPrice: entry.sellPrice,
      quantity: entry.quantity ?? 100,
      numAuctions: 10,
      event: false
    }))
    .sort((left, right) => left.t - right.t);
}

function input(seriesPoints: SeriesPoint[], quoteOverrides: Partial<MarketQuote> = {}, itemOverrides: Record<string, unknown> = {}): SignalInput {
  return {
    item: {
      itemId: 2770,
      name: "铜矿石",
      quality: "common",
      category: "商品",
      subCategory: "金属和矿石",
      vendorPrice: 0,
      iconId: 101,
      ...itemOverrides
    },
    quote: quote(quoteOverrides),
    series: seriesPoints
  };
}

describe("buildMarketSignal", () => {
  it("derives the sell front, spread, trend and supply from the series", () => {
    const signal = buildMarketSignal(
      input(points([
        { daysAgo: 2, sellPrice: 100 },
        { daysAgo: 1, sellPrice: 120 },
        { daysAgo: 0, sellPrice: 110 }
      ]), { sellPrice: 110, minPrice: 80, quantity: 240, sellerCount: 5 }),
      now
    );
    expect(signal.sellPrice).toBe(110);
    expect(signal.minPrice).toBe(80);
    expect(signal.quantity).toBe(240);
    expect(signal.sellerCount).toBe(5);
    expect(signal.sellRef).toBe(110); // lower median of [100, 110, 120]
    expect(signal.spreadPercent).toBeCloseTo((1 - 80 / 110) * 100, 5);
    expect(signal.trendPercent).toBeCloseTo(0, 5);
    expect(signal.changePercent).toBeCloseTo(((110 - 120) / 120) * 100, 5);
  });

  it("falls back to P10 when a legacy row has no sell front", () => {
    const signal = buildMarketSignal(
      input(points([{ daysAgo: 0, sellPrice: 900 }]), { sellPrice: 0, marketPrice: 900, minPrice: 700 }),
      now
    );
    expect(signal.sellPrice).toBe(900);
    expect(signal.sellRef).toBe(900);
  });

  it("counts only priced observations in the window sample size", () => {
    const signal = buildMarketSignal(
      input(
        [
          { t: Math.round((now.getTime() - 3 * DAY) / 1000), minPrice: 90, sellPrice: 100, quantity: 100, numAuctions: 10, event: false },
          { t: Math.round((now.getTime() - 2 * DAY) / 1000), minPrice: 0, sellPrice: 0, quantity: 0, numAuctions: 0, event: false },
          { t: Math.round((now.getTime() - DAY) / 1000), minPrice: 99, sellPrice: 110, quantity: 100, numAuctions: 10, event: false }
        ],
        { sellPrice: 110 }
      ),
      now
    );
    expect(signal.sellSamples).toBe(2);
    expect(signal.sellRef).toBe(100);
  });

  it("trusts the scanner's history stamp over the terminal's recount", () => {
    const stamped = buildMarketSignal(
      input(points([{ daysAgo: 0, sellPrice: 100 }]), { historySamples: 42, historySpanHours: 20 }),
      now
    );
    expect(stamped.historySamples).toBe(42);
    expect(stamped.historySpanHours).toBe(20);
    expect(stamped.sellSamples).toBe(1);
    // Without a stamp the series answers the same question.
    const unstamped = buildMarketSignal(input(points([{ daysAgo: 1, sellPrice: 90 }, { daysAgo: 0, sellPrice: 100 }])), now);
    expect(unstamped.historySamples).toBe(2);
  });

  it("carries the truncated-ladder flag from the quote", () => {
    expect(buildMarketSignal(input(points([{ daysAgo: 0, sellPrice: 100 }]), { tierTruncated: true }), now).tierTruncated).toBe(true);
    expect(buildMarketSignal(input(points([{ daysAgo: 0, sellPrice: 100 }])), now).tierTruncated).toBe(false);
  });

  it("builds the reference from every retained series point in the phase window", () => {
    const series = points([
      { daysAgo: 4, sellPrice: 400 },
      { daysAgo: 3, sellPrice: 400 },
      { daysAgo: 2, sellPrice: 400 },
      { daysAgo: 1, sellPrice: 400 },
      { daysAgo: 3 / 24, sellPrice: 100 },
      { daysAgo: 2 / 24, sellPrice: 100 },
      { daysAgo: 1 / 24, sellPrice: 100 }
    ]);
    const steady = buildMarketSignal(input(series), now, { phase: "steady" });
    expect(steady.sellRef).toBe(400);
    expect(steady.sellSamples).toBe(7);
    const wave = buildMarketSignal(input(series), now, { phase: "wave" });
    expect(wave.sellRef).toBe(100);
    expect(wave.sellSamples).toBe(3);
  });

  it("measures spread at the current sell front, not the window reference", () => {
    const signal = buildMarketSignal(
      input(points([
        { daysAgo: 2, sellPrice: 100 },
        { daysAgo: 1, sellPrice: 100 },
        { daysAgo: 0, sellPrice: 120 }
      ]), { sellPrice: 120, minPrice: 80 }),
      now
    );
    expect(signal.sellRef).toBe(100);
    expect(signal.spreadPercent).toBeCloseTo((1 - 80 / 120) * 100, 5);
  });

  it("keeps P10 as a separate statistic, not the reference", () => {
    const signal = buildMarketSignal(
      input(points([
        { daysAgo: 2, sellPrice: 100 },
        { daysAgo: 1, sellPrice: 120 },
        { daysAgo: 0, sellPrice: 110 }
      ]), { sellPrice: 110, marketPrice: 500 }),
      now
    );
    expect(signal.price).toBe(500);
    expect(signal.sellRef).toBe(110);
    expect(signal.spreadPercent).toBeCloseTo((1 - 99 / 110) * 100, 5);
  });

  it("ignores a series point later than the signal's own scan", () => {
    // The addon file can already hold the next scan when an older duplicate
    // is replayed. A stored signal must describe its own generation, not a
    // future price.
    const series = points([
      { daysAgo: 0, sellPrice: 110 },
      { daysAgo: -1, sellPrice: 999999 }
    ]);
    const signal = buildMarketSignal(input(series, { sellPrice: 110 }), now);
    expect(signal.sellRef).toBe(110);
    expect(signal.spark).toEqual([110]);
  });

  it("ignores series points outside the phase window", () => {
    const signal = buildMarketSignal(
      input(points([
        { daysAgo: 20, sellPrice: 999999 },
        { daysAgo: 1, sellPrice: 100 },
        { daysAgo: 0, sellPrice: 110 }
      ]), { sellPrice: 110 }),
      now,
      { phase: "settle" }
    );
    expect(signal.sellRef).toBe(100);
  });

  it("reports the deflated price when a price index is supplied", () => {
    const series = points([
      { daysAgo: 1, sellPrice: 100 },
      { daysAgo: 0, sellPrice: 200 }
    ]);
    const index = buildPriceIndex([{ itemId: 2770, points: series }]);
    const signal = buildMarketSignal(input(series, { sellPrice: 200 }), now, { index });
    expect(signal.realSellPrice).not.toBeNull();
    expect(signal.realSellPrice!).toBeLessThan(signal.sellPrice);
  });

  it("carries demand and inferred-flow fields straight from the quote", () => {
    const signal = buildMarketSignal(
      input(points([{ daysAgo: 0, sellPrice: 100 }]), { bidOnlyCount: 4 }),
      now
    );
    expect(signal.bidOnlyCount).toBe(4);
    expect(signal.inferredSoldLow).toBe(0);
    expect(signal.inferredSoldHigh).toBe(0);
    expect(signal.sellersInvisible).toBe(false);
  });

  it("flags an item whose quote predates the current scan", () => {
    const scannedAt = new Date(now.getTime() + 60 * 60 * 1000);
    expect(buildMarketSignal(input(points([{ daysAgo: 1, sellPrice: 100 }])), now, { currentAt: scannedAt }).stale).toBe(true);
    expect(buildMarketSignal(input(points([{ daysAgo: 1, sellPrice: 100 }])), now).stale).toBe(false);
  });

  it("still prices an item whose series is empty", () => {
    const signal = buildMarketSignal(input([], { sellPrice: 500, minPrice: 400 }), now);
    expect(signal.sellPrice).toBe(500);
    expect(signal.sellRef).toBe(500);
    expect(signal.spark).toEqual([]);
  });

  it("carries the catalogue icon and subclass onto the signal", () => {
    const signal = buildMarketSignal(input(points([{ daysAgo: 0, sellPrice: 100 }])), now);
    expect(signal.iconId).toBe(101);
    expect(signal.subCategory).toBe("金属和矿石");
  });
});

describe("sellFrontByItem", () => {
  it("keeps the current book and drops a delisted item's old price", () => {
    const prices = sellFrontByItem([
      { itemId: 1, sellPrice: 250, stale: false },
      { itemId: 2, sellPrice: 900, stale: true }
    ]);
    expect(prices.get(1)).toBe(250);
    expect(prices.has(2)).toBe(false);
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
