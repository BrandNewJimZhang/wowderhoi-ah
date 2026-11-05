import { describe, expect, it } from "vitest";
import type { MarketSignal } from "@/lib/analytics";
import { filterSortSignals, paginate, parseMarketView } from "@/lib/market-filter";

function makeSignal(partial: Partial<MarketSignal> & Pick<MarketSignal, "itemId" | "name">): MarketSignal {
  return {
    sellPrice: 100,
    minPrice: 90,
    price: 100,
    category: "unknown",
    quality: "common",
    quantity: 0,
    numAuctions: 0,
    sellerCount: 0,
    sellersInvisible: false,
    ownerVisible: false,
    sellerHHI: null,
    topSellerShare: null,
    marketType: null,
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    supplyGrowth: 0,
    vendorPrice: 0,
    stale: false,
    sellRef: 100,
    sellSamples: 1,
    spreadPercent: 10,
    trendPercent: 0,
    changePercent: 0,
    realSellPrice: null,
    ...partial
  };
}

const signals = [
  makeSignal({ itemId: 1, name: "魔铁矿石", category: "矿石", sellPrice: 300, changePercent: -5 }),
  makeSignal({ itemId: 2, name: "精金矿石", category: "矿石", sellPrice: 900, changePercent: 10 }),
  makeSignal({ itemId: 3, name: "梦叶草", category: "草药", sellPrice: 150, changePercent: 2 }),
  makeSignal({ itemId: 4, name: "碎骨头", category: "垃圾", sellPrice: 800 })
];

describe("filterSortSignals", () => {
  it("filters by case-insensitive name substring", () => {
    expect(filterSortSignals(signals, { query: "矿石" }).map((signal) => signal.itemId)).toEqual([1, 2]);
    expect(filterSortSignals(signals, { query: "梦叶" })).toHaveLength(1);
  });

  it("filters by category", () => {
    expect(filterSortSignals(signals, { category: "草药" }).map((signal) => signal.itemId)).toEqual([3]);
  });

  it("sorts by a numeric key in both directions", () => {
    expect(filterSortSignals(signals, { sortKey: "sellPrice" }).map((signal) => signal.itemId)).toEqual([2, 4, 1, 3]);
    expect(filterSortSignals(signals, { sortKey: "changePercent", sortAsc: true }).map((signal) => signal.itemId)[0]).toBe(1);
  });

  it("keeps delisted rows below every tradeable row under any sort", () => {
    const stale = makeSignal({ itemId: 9, name: "下架货", sellPrice: 9999, spreadPercent: 99, stale: true });
    const fresh = makeSignal({ itemId: 8, name: "在售货", sellPrice: 10, spreadPercent: 1 });
    expect(filterSortSignals([stale, fresh], { sortKey: "sellPrice" }).map((signal) => signal.itemId)).toEqual([8, 9]);
    expect(filterSortSignals([stale, fresh], { sortKey: "spreadPercent" }).map((signal) => signal.itemId)).toEqual([8, 9]);
  });

  it("composes query, category, and sort without mutating the input", () => {
    const result = filterSortSignals(signals, { query: "矿", category: "矿石", sortKey: "sellPrice", sortAsc: true });
    expect(result.map((signal) => signal.itemId)).toEqual([1, 2]);
    expect(signals[0].itemId).toBe(1);
  });
});

describe("parseMarketView", () => {
  it("returns defaults for empty params", () => {
    expect(parseMarketView({})).toEqual({ query: "", category: "", sortKey: "spreadPercent", sortAsc: false, page: 1 });
  });

  it("reads query, category, sort key, direction, and page", () => {
    expect(parseMarketView({ q: "矿石", cat: "矿石", sort: "sellPrice", dir: "asc", page: "3" })).toEqual({
      query: "矿石",
      category: "矿石",
      sortKey: "sellPrice",
      sortAsc: true,
      page: 3
    });
  });

  it("falls back to defaults on an unknown sort key or invalid page", () => {
    const view = parseMarketView({ sort: "evil'); DROP TABLE", page: "-4" });
    expect(view.sortKey).toBe("spreadPercent");
    expect(view.page).toBe(1);
    expect(parseMarketView({ page: "abc" }).page).toBe(1);
  });

  it("uses the first value when a param repeats", () => {
    expect(parseMarketView({ q: ["a", "b"], sort: ["sellRef", "sellPrice"] })).toMatchObject({ query: "a", sortKey: "sellRef" });
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 120 }, (_, index) => index);

  it("slices the requested page and reports page count", () => {
    const page = paginate(rows, 2, 50);
    expect(page.rows).toHaveLength(50);
    expect(page.rows[0]).toBe(50);
    expect(page.pageCount).toBe(3);
    expect(page.page).toBe(2);
  });

  it("clamps out-of-range pages instead of returning empty", () => {
    expect(paginate(rows, 99, 50).page).toBe(3);
    expect(paginate(rows, 0, 50).page).toBe(1);
    expect(paginate([], 1, 50)).toEqual({ rows: [], page: 1, pageCount: 1 });
  });
});
