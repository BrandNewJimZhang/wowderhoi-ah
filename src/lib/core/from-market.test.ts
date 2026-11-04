import { describe, expect, it } from "vitest";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { MarketSignal } from "@/lib/analytics";
import type { MarketHistory } from "@/lib/market-data";

const EARLIEST = new Date("2026-07-20T00:00:00Z");
const LATEST = new Date("2026-07-21T00:00:00Z");

function history(itemId: number): MarketHistory {
  return {
    itemId,
    name: `Item ${itemId}`,
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    vendorPrice: 0,
    snapshots: [
      {
        timestamp: EARLIEST,
        minPrice: 700,
        marketPrice: 900,
        sellPrice: 1000,
        quantity: 500,
        numAuctions: 10,
        sellerCount: 4,
        topTiers: [{ p: 700, q: 100 }, { p: 1000, q: 400 }]
      },
      {
        timestamp: LATEST,
        minPrice: 700,
        marketPrice: 900,
        sellPrice: 1000,
        quantity: 500,
        numAuctions: 10,
        sellerCount: 4,
        topTiers: [{ p: 700, q: 100 }, { p: 1000, q: 400 }]
      }
    ],
    dailySummaries: []
  } as unknown as MarketHistory;
}

function signal(itemId: number): MarketSignal {
  return {
    itemId,
    name: `Item ${itemId}`,
    category: "Trade Goods",
    quality: "common",
    sellPrice: 1000,
    minPrice: 700,
    price: 900,
    quantity: 500,
    numAuctions: 10,
    sellerCount: 4,
    sellersInvisible: false,
    marketType: null,
    bidOnlyCount: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    supplyGrowth: 0,
    vendorPrice: 0,
    sellRef: 1000,
    sellSamples: 2,
    spreadPercent: 30,
    trendPercent: 0,
    changePercent: 0,
    realSellPrice: null
  };
}

function pairs(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    history: history(index + 1),
    signal: signal(index + 1)
  }));
}

describe("buildCoreInput", () => {
  it("hands the resolved phase to the core instead of letting it re-derive one", () => {
    // A live market: the newest snapshot is minutes old, but the market has
    // been observed for a day. The core must receive wave, not ignition.
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "wave" });
    expect(input.phaseOverride).toBe("wave");
    expect(runCore(input).phase).toBe("wave");
  });

  it("uses the oldest snapshot as the market's first scan", () => {
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "wave" });
    expect(input.market.firstScanAt).toBe(EARLIEST.getTime() / 1000);
    const output = runCore(input);
    expect(output.ageHours).toBeCloseTo(24, 5);
  });

  it("keeps scanned cash and the planning budget as separate inputs", () => {
    // In game, cash is GetMoney() and budget is the spend cap; the terminal
    // used to pass the budget as cash, so the two sides disagreed about
    // what "cash" means even when they ran the same core.
    const input = buildCoreInput(pairs(), {
      now: LATEST,
      phase: "wave",
      budgetCopper: 500000,
      cashCopper: 123456
    });
    expect(input.capital?.cash).toBe(123456);
    expect(input.capital?.budget).toBe(500000);
  });

  it("hands the scan's market classification to the core", () => {
    // A Trade Goods item would derive as a commodity from its class, but the
    // scanner saw a unique-lot book. The scan's classification is the
    // authority, so the core must not re-derive one from the category.
    const classified = pairs(1);
    classified[0].signal.marketType = "item";
    const input = buildCoreInput(classified, { now: LATEST, phase: "wave" });
    expect(input.market.items[1].marketType).toBe("item");
  });

  it("prefers the store's first snapshot time when the caller knows it", () => {
    const tenDaysAgo = new Date("2026-07-11T00:00:00Z");
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "settle", firstScanAt: tenDaysAgo });
    expect(input.market.firstScanAt).toBe(tenDaysAgo.getTime() / 1000);
    expect(input.phaseOverride).toBe("settle");
  });
});
