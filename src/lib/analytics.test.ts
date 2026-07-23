import { describe, expect, it } from "vitest";
import { buildDealRadar, buildMarketSignal, buildWeekdaySeasonality } from "@/lib/analytics";
import { generateDemoHistory } from "@/lib/demo-history";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-24T12:00:00Z");

function history(
  snapshots: Array<{ daysAgo: number; marketPrice: number; minPrice?: number; quantity?: number; numAuctions?: number }>,
  overrides?: { vendorPrice?: number; itemId?: number; name?: string }
) {
  return {
    itemId: overrides?.itemId ?? 2770,
    name: overrides?.name ?? "铜矿石",
    quality: "common",
    category: "矿石",
    subCategory: "采矿",
    vendorPrice: overrides?.vendorPrice ?? 0,
    icon: null,
    snapshots: snapshots.map((snap) => ({
      timestamp: new Date(now.getTime() - snap.daysAgo * DAY),
      server: "Anniversary",
      faction: "Alliance",
      minPrice: snap.minPrice ?? Math.round(snap.marketPrice * 0.9),
      marketPrice: snap.marketPrice,
      quantity: snap.quantity ?? 100,
      numAuctions: snap.numAuctions ?? 10
    })),
    dailySummaries: []
  };
}

describe("buildMarketSignal", () => {
  it("derives snapshot-based stats: latest P50, min, med7, discount", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 2, marketPrice: 100 },
        { daysAgo: 1, marketPrice: 120 },
        { daysAgo: 0, marketPrice: 110, minPrice: 80, quantity: 240, numAuctions: 12 }
      ]),
      now
    );
    expect(signal.price).toBe(110);
    expect(signal.minPrice).toBe(80);
    expect(signal.quantity).toBe(240);
    expect(signal.numAuctions).toBe(12);
    expect(signal.med7).toBe(110); // median of [100, 110, 120]
    expect(signal.discountPercent).toBeCloseTo((1 - 80 / 110) * 100, 5);
    expect(signal.changePercent).toBeCloseTo(((110 - 120) / 120) * 100, 5);
  });

  it("median ignores snapshots older than 7 days and resists outliers", () => {
    const signal = buildMarketSignal(
      history([
        { daysAgo: 10, marketPrice: 999999 }, // outside window
        { daysAgo: 1, marketPrice: 100 },
        { daysAgo: 0.5, marketPrice: 999999 }, // bait inside window
        { daysAgo: 0.2, marketPrice: 105 },
        { daysAgo: 0, marketPrice: 95 }
      ]),
      now
    );
    // window prices [100, 999999, 105, 95] -> sorted [95,100,105,999999] -> lower middle 100
    expect(signal.med7).toBe(100);
  });

  it("reports zeros honestly with a single scan instead of fabricating", () => {
    const signal = buildMarketSignal(history([{ daysAgo: 0, marketPrice: 100 }]), now);
    expect(signal.changePercent).toBe(0);
    expect(signal.med7).toBe(100);
  });

  it("works over the demo fixture (test-only universe)", () => {
    const signal = buildMarketSignal(generateDemoHistory(5)[0], new Date());
    expect(signal.price).toBeGreaterThan(0);
    expect(signal.med7).toBeGreaterThan(0);
  });
});

describe("buildDealRadar", () => {
  // Mirrors the in-game radar (addon/WoWderhoiAH/Trade.lua): vendor
  // arbitrage plus median discount, both gated on a 5s profit floor.
  const liquid = { quantity: 100, numAuctions: 10 };

  function signals(items: Parameters<typeof buildMarketSignal>[0][]) {
    return items.map((item) => buildMarketSignal(item, now));
  }

  it("flags vendor arbitrage without any history depth", () => {
    const deals = buildDealRadar(
      signals([history([{ daysAgo: 0, marketPrice: 900, minPrice: 400, ...liquid }], { vendorPrice: 1000 })])
    );
    expect(deals).toHaveLength(1);
    expect(deals[0].vendor).toBe(true);
    expect(deals[0].profit).toBe(600); // vendorPrice 1000 - minPrice 400
  });

  it("requires the 15% discount, 3-scan depth, 3-auction liquidity, and 5s floor together", () => {
    const base = [
      { daysAgo: 2, marketPrice: 10000, ...liquid },
      { daysAgo: 1, marketPrice: 10000, ...liquid }
    ];
    const qualifying = history([...base, { daysAgo: 0, marketPrice: 10000, minPrice: 8000, ...liquid }]);
    const thinDiscount = history([...base, { daysAgo: 0, marketPrice: 10000, minPrice: 9000, ...liquid }], { itemId: 2 });
    const shallowHistory = history([{ daysAgo: 0, marketPrice: 10000, minPrice: 8000, ...liquid }], { itemId: 3 });
    const illiquid = history([...base, { daysAgo: 0, marketPrice: 10000, minPrice: 8000, quantity: 2, numAuctions: 2 }], { itemId: 4 });
    const subSilver = history(
      [
        { daysAgo: 2, marketPrice: 100, ...liquid },
        { daysAgo: 1, marketPrice: 100, ...liquid },
        { daysAgo: 0, marketPrice: 100, minPrice: 50, ...liquid }
      ],
      { itemId: 5 }
    );
    const deals = buildDealRadar(signals([qualifying, thinDiscount, shallowHistory, illiquid, subSilver]));
    expect(deals.map((deal) => deal.itemId)).toEqual([2770]);
    expect(deals[0].vendor).toBe(false);
    expect(deals[0].profit).toBe(2000);
  });

  it("orders vendor deals first, then by absolute profit", () => {
    const smallVendor = history([{ daysAgo: 0, marketPrice: 900, minPrice: 400, ...liquid }], { vendorPrice: 1000, itemId: 1 });
    const bigMedian = history(
      [
        { daysAgo: 2, marketPrice: 50000, ...liquid },
        { daysAgo: 1, marketPrice: 50000, ...liquid },
        { daysAgo: 0, marketPrice: 50000, minPrice: 10000, ...liquid }
      ],
      { itemId: 2 }
    );
    const deals = buildDealRadar(signals([bigMedian, smallVendor]));
    expect(deals.map((deal) => deal.itemId)).toEqual([1, 2]);
  });
});

describe("buildWeekdaySeasonality", () => {
  it("uses median closes so one spike day cannot skew a weekday", () => {
    // Mondays: [100, 100, 999999] -> median 100; Tuesdays: [200]
    const summaries = [
      { date: new Date("2026-07-06T00:00:00Z"), closePrice: 100, volume: 10 },
      { date: new Date("2026-07-13T00:00:00Z"), closePrice: 100, volume: 10 },
      { date: new Date("2026-07-20T00:00:00Z"), closePrice: 999999, volume: 10 },
      { date: new Date("2026-07-07T00:00:00Z"), closePrice: 200, volume: 30 }
    ];
    const seasonality = buildWeekdaySeasonality(summaries);
    const monday = seasonality.find((day) => day.weekday === 1)!;
    const tuesday = seasonality.find((day) => day.weekday === 2)!;
    // overall median = median of [100,100,999999,200] = 100
    expect(monday.priceDeviation).toBeCloseTo(0, 5);
    expect(tuesday.priceDeviation).toBeCloseTo(100, 5);
    expect(monday.listedShare).toBeCloseTo(50, 5);
    expect(seasonality.find((day) => day.weekday === 6)).toBeUndefined();
  });
});
