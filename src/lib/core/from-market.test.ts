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
    ownerVisible: false,
    sellerHHI: null,
    topSellerShare: null,
    marketType: null,
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    vendorPrice: 0,
    stale: false,
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
    // The core reads cash and budget only. Mail and escrow were carried in
    // the contract but never consumed, so they must not travel between the
    // builders.
    expect(Object.keys(input.capital ?? {}).sort()).toEqual(["budget", "cash"]);
  });

  it("hands the scan's free bag slots to the core", () => {
    // The terminal has no bag access; the scan is the only source. A value
    // of 0 is a real observation and must not be replaced by the fallback.
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave", bagSlots: 3 }).capacity?.bagSlots).toBe(3);
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave", bagSlots: 0 }).capacity?.bagSlots).toBe(0);
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave" }).capacity?.bagSlots).toBe(20);
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

  it("carries item quality into the core rows", () => {
    // The in-game builder hands the core the scan's quality; without it the
    // terminal's radar rows fell back to "unknown" and lost their color.
    const input = buildCoreInput(pairs(1), { now: LATEST, phase: "wave" });
    expect(input.market.items[1].quality).toBe("common");
  });

  it("ships exactly the fields the core reads", () => {
    // The sub-category is consumed twice: to build the demand prior and to
    // match a scheduled event window inside Core.eventBoost. Both runtimes
    // therefore carry it.
    const input = buildCoreInput(pairs(1), { now: LATEST, phase: "wave" });
    expect(input.market.items[1].itemSubClass).toBe("Herb");
    expect(input.market.items[1].demandPrior).toBe(1.2);
    expect(input.market.items[1].ownerVisible).toBe(false);
    expect(input.market.items[1].sellerHHI).toBeNull();
  });

  it("prefers the store's first snapshot time when the caller knows it", () => {
    const tenDaysAgo = new Date("2026-07-11T00:00:00Z");
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "settle", firstScanAt: tenDaysAgo });
    expect(input.market.firstScanAt).toBe(tenDaysAgo.getTime() / 1000);
    expect(input.phaseOverride).toBe("settle");
  });
});

describe("bid demand signal", () => {
  it("carries the highest bid into the core input", () => {
    const input = buildCoreInput(
      [{ history: history(2589), signal: { ...signal(2589), bidOnlyCount: 2, highestBid: 800 } }],
      { now: LATEST, phase: "ignition" }
    );
    expect(input.market.items[2589].highestBid).toBe(800);
    expect(input.market.items[2589].bidOnly).toBe(2);
  });
});
