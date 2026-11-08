import { describe, expect, it } from "vitest";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { MarketSignal } from "@/lib/analytics";
import type { MarketQuote } from "@/lib/market-data";
import { signalFixture } from "@/lib/signal-fixture";

const EARLIEST = new Date("2026-07-20T00:00:00Z");
const LATEST = new Date("2026-07-21T00:00:00Z");

function quote(): MarketQuote {
  return {
    timestamp: LATEST,
    priced: true,
    minPrice: 700,
    marketPrice: 900,
    sellPrice: 1000,
    p5Price: 720,
    quantity: 500,
    numAuctions: 10,
    sellerCount: 4,
    sellersInvisible: false,
    ownerVisible: false,
    observationVersion: 2,
    sellerHHI: null,
    topSellerShare: null,
    marketType: null,
    bidOnlyCount: 0,
    highestBid: 0,
    soldProxyLow: 0,
    soldProxyHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    historySamples: null,
    historySpanHours: null,
    tierTruncated: false,
    topTiers: [{ p: 700, q: 100 }, { p: 1000, q: 400 }],
    expiring: null
  };
}

function signal(itemId: number, overrides: Partial<MarketSignal> = {}): MarketSignal {
  return signalFixture({
    itemId,
    name: `Item ${itemId}`,
    category: "Trade Goods",
    subCategory: "Herb",
    sellPrice: 1000,
    minPrice: 700,
    price: 900,
    quantity: 500,
    numAuctions: 10,
    sellerCount: 4,
    vendorPrice: 0,
    sellRef: 1000,
    sellSamples: 2,
    historySamples: 2,
    ...overrides
  });
}

function pairs(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    signal: signal(index + 1),
    quote: quote(),
    previousAt: EARLIEST
  }));
}

describe("buildCoreInput", () => {
  it("hands the resolved phase to the core instead of letting it re-derive one", () => {
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "wave" });
    expect(input.phaseOverride).toBe("wave");
    expect(runCore(input).phase).toBe("wave");
  });

  it("uses the caller's persisted first observation, not the quote's timestamp", () => {
    const tenDaysAgo = new Date("2026-07-11T00:00:00Z");
    const input = buildCoreInput(pairs(), { now: LATEST, phase: "settle", firstScanAt: tenDaysAgo });
    expect(input.market.firstScanAt).toBe(tenDaysAgo.getTime() / 1000);
    expect(input.phaseOverride).toBe("settle");
  });

  it("measures elapsed time from the previous series point, floored at the scan interval", () => {
    const input = buildCoreInput(pairs(1), { now: LATEST, phase: "wave" });
    expect(input.market.items[1].elapsedHours).toBe(24);
    const none = buildCoreInput([{ signal: signal(1), quote: quote(), previousAt: null }], { now: LATEST, phase: "wave" });
    expect(none.market.items[1].elapsedHours).toBe(0.25);
  });

  it("keeps scanned cash and the planning budget as separate inputs", () => {
    const input = buildCoreInput(pairs(), {
      now: LATEST,
      phase: "wave",
      budgetCopper: 500000,
      cashCopper: 123456
    });
    expect(input.capital?.cash).toBe(123456);
    expect(input.capital?.budget).toBe(500000);
    expect(Object.keys(input.capital ?? {}).sort()).toEqual(["budget", "cash"]);
  });

  it("hands the scan's free bag slots to the core", () => {
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave", bagSlots: 3 }).capacity?.bagSlots).toBe(3);
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave", bagSlots: 0 }).capacity?.bagSlots).toBe(0);
    expect(buildCoreInput(pairs(), { now: LATEST, phase: "wave" }).capacity?.bagSlots).toBe(20);
  });

  it("hands the scan's market classification to the core", () => {
    const classified = [{ signal: signal(1, { marketType: "item" }), quote: quote(), previousAt: null }];
    expect(buildCoreInput(classified, { now: LATEST, phase: "wave" }).market.items[1].marketType).toBe("item");
  });

  it("carries item quality and subclass into the core rows", () => {
    const input = buildCoreInput(pairs(1), { now: LATEST, phase: "wave" });
    expect(input.market.items[1].quality).toBe("common");
    expect(input.market.items[1].itemSubClass).toBe("Herb");
    expect(input.market.items[1].demandPrior).toBe(1.2);
    expect(input.market.items[1].ownerVisible).toBe(false);
    expect(input.market.items[1].sellerHHI).toBeNull();
  });

  it("passes the materialised history count to the core", () => {
    const stamped = [{ signal: signal(1, { historySamples: 42, sellSamples: 7 }), quote: quote(), previousAt: null }];
    expect(buildCoreInput(stamped, { now: LATEST, phase: "wave" }).market.items[1].history)
      .toEqual({ samples: 42 });
    const empty = [{ signal: signal(1, { historySamples: 0, sellSamples: 7 }), quote: quote(), previousAt: null }];
    expect(buildCoreInput(empty, { now: LATEST, phase: "wave" }).market.items[1].history)
      .toEqual({ samples: 0 });
  });

  it("uses the quote's ladder, not a daily aggregate", () => {
    const input = buildCoreInput(pairs(1), { now: LATEST, phase: "wave" });
    expect(input.market.items[1].tiers).toEqual([{ p: 700, q: 100 }, { p: 1000, q: 400 }]);
  });

  it("maps a null vendor price to no vendor arbitrage", () => {
    const input = buildCoreInput(
      [{ signal: signal(1, { vendorPrice: null }), quote: quote(), previousAt: null }],
      { now: LATEST, phase: "wave" }
    );
    expect(input.market.items[1].vendorP).toBe(0);
  });
});

describe("bid demand signal", () => {
  it("carries the highest bid into the core input", () => {
    const input = buildCoreInput(
      [{ signal: signal(2589, { bidOnlyCount: 2, highestBid: 800 }), quote: quote(), previousAt: null }],
      { now: LATEST, phase: "ignition" }
    );
    expect(input.market.items[2589].highestBid).toBe(800);
    expect(input.market.items[2589].bidOnly).toBe(2);
  });
});
