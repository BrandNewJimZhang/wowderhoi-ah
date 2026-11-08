import { describe, expect, it } from "vitest";
import type { AddonScan, AddonScanItem } from "@/lib/addon-scan";
import { decisionIdFor } from "@/lib/decision-id";
import type { MarketQuote, SignalItem } from "@/lib/market-data";
import type { SeriesPoint } from "@/lib/item-series";
import { buildGenerationPlan, type GenerationInput } from "@/lib/market-generation";

const SCANNED_AT = new Date("2026-11-08T07:58:00Z");
const SCAN_SECONDS = Math.round(SCANNED_AT.getTime() / 1000);
const DAY = 24 * 60 * 60;

const HERB: SignalItem = {
  itemId: 1, name: "梦叶草", quality: "common", category: "商品", subCategory: "草药",
  vendorPrice: 10, iconId: 100
};
const ORE: SignalItem = {
  itemId: 2, name: "铜矿石", quality: "common", category: "商品", subCategory: "金属和矿石",
  vendorPrice: 5, iconId: 101
};

function scanItem(partial: Partial<AddonScanItem> & Pick<AddonScanItem, "itemId" | "name">): AddonScanItem {
  return {
    quality: "common",
    category: "商品",
    subCategory: "草药",
    marketType: "commodity",
    priced: true,
    minPrice: 100,
    marketPrice: 150,
    sellPrice: 200,
    p5Price: 110,
    quantity: 200,
    numAuctions: 10,
    sellerCount: 4,
    sellersInvisible: false,
    // Hidden owners keep the fill estimate on the phase prior, which is the
    // path this pipeline test exercises; an observable book with ten
    // disappearances over a day is a slow mover the core correctly refuses.
    ownerVisible: false,
    sellerHHI: 0.2,
    topSellerShare: 0.4,
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    historySamples: 6,
    historySpanHours: 20,
    tierTruncated: false,
    tiers: [{ p: 100, q: 100 }, { p: 150, q: 100 }],
    expiring: { soon: 1, mid: 2, late: 3 },
    vendorPrice: 10,
    ...partial
  };
}

function scan(): AddonScan {
  return {
    scannedAt: SCANNED_AT,
    server: "Realm",
    faction: "Alliance",
    character: "Tester",
    cash: 1_000_000,
    openedAt: null,
    bagSlots: 10,
    observationVersion: 2,
    skippedItems: 0,
    items: [
      scanItem({ itemId: 1, name: "梦叶草" }),
      scanItem({
        itemId: 3, name: "仅竞价物品", priced: false, minPrice: 0, marketPrice: 0, sellPrice: 0,
        p5Price: 0, quantity: 0, numAuctions: 0, sellerCount: 0, bidOnlyCount: 2, highestBid: 500, tiers: []
      })
    ]
  };
}

function seriesPoint(t: number, sellPrice: number, itemId = 1): SeriesPoint & { itemId: number } {
  return { itemId, t, minPrice: sellPrice - 20, sellPrice, quantity: 100, numAuctions: 5, event: false };
}

function previousQuote(sellPrice: number): MarketQuote {
  return {
    timestamp: new Date((SCAN_SECONDS - 30 * 60) * 1000),
    priced: true,
    minPrice: 70,
    marketPrice: 90,
    sellPrice,
    p5Price: 75,
    quantity: 50,
    numAuctions: 3,
    sellerCount: 2,
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
    historySamples: 4,
    historySpanHours: 12,
    tierTruncated: false,
    topTiers: [{ p: 70, q: 50 }],
    expiring: null
  };
}

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    scan: scan(),
    series: {
      firstScanAt: SCAN_SECONDS - 3 * DAY,
      timestamps: [],
      points: [
        seriesPoint(SCAN_SECONDS - 3 * DAY, 150),
        seriesPoint(SCAN_SECONDS - 2 * DAY, 170),
        seriesPoint(SCAN_SECONDS - DAY, 180),
        seriesPoint(SCAN_SECONDS, 200)
      ]
    },
    items: new Map([[1, HERB], [2, ORE]]),
    existingSeries: [],
    previous: null,
    openedAt: null,
    firstScanAt: null,
    positions: {},
    ownSales: {},
    budgetCopper: 1_000_000,
    phaseOverride: "ignition",
    ...overrides
  };
}

describe("buildGenerationPlan", () => {
  it("materialises the current book, the signals and the core output", () => {
    const plan = buildGenerationPlan(input());
    expect(plan.quotes).toHaveLength(2);
    expect(plan.breadth).toBe(1);
    expect(plan.signals).toHaveLength(1);
    expect(plan.signals[0].data.signal.sellPrice).toBe(200);
    expect(plan.signals[0].data.signal.historySamples).toBe(6);
    expect(plan.core.rows.length).toBeGreaterThan(0);
    expect(plan.signals[0].data.coreRow?.itemId).toBe(1);
    expect(plan.decisions[0].decisionId).toBe(
      decisionIdFor({ realm: "Realm", faction: "Alliance", scannedAt: SCANNED_AT, itemId: 1, kind: "buy" })
    );
    expect(plan.firstScanAt.getTime()).toBe((SCAN_SECONDS - 3 * DAY) * 1000);
    expect(plan.priceIndex.dates.length).toBeGreaterThanOrEqual(3);
  });

  it("merges the series idempotently when the same scan is imported twice", () => {
    const first = buildGenerationPlan(input());
    const second = buildGenerationPlan(input({
      existingSeries: first.series.map((row) => ({ itemId: row.itemId, points: row.points }))
    }));
    expect(second.series.map((row) => row.pointCount)).toEqual(first.series.map((row) => row.pointCount));
    expect(second.signals[0].data.signal.sellPrice).toBe(200);
  });

  it("keeps a delisted item as a stale signal and out of the core", () => {
    const plan = buildGenerationPlan(input({
      previous: {
        scannedAt: new Date((SCAN_SECONDS - 30 * 60) * 1000),
        quotes: [{ item: ORE, quote: previousQuote(120) }]
      },
      existingSeries: [{ itemId: 2, points: [seriesPoint(SCAN_SECONDS - 30 * 60, 120)] }]
    }));
    const stale = plan.signals.find((row) => row.itemId === 2)?.data;
    expect(stale?.signal.stale).toBe(true);
    expect(stale?.coreRow).toBeNull();
    expect(plan.staleCount).toBe(1);
    expect(plan.core.rows.some((row) => row.itemId === 2)).toBe(false);
    expect(plan.gapMinutes).toBe(30);
    expect(plan.series.some((row) => row.itemId === 2)).toBe(true);
  });

  it("carries the previous priced book when the newest scan only has bids", () => {
    const bidsOnly = scan();
    bidsOnly.items = [
      scanItem({
        itemId: 1, name: "梦叶草", priced: false, minPrice: 0, marketPrice: 0, sellPrice: 0,
        p5Price: 0, quantity: 0, numAuctions: 0, sellerCount: 0, bidOnlyCount: 3, highestBid: 700, tiers: []
      })
    ];
    const plan = buildGenerationPlan(input({
      scan: bidsOnly,
      previous: {
        scannedAt: new Date((SCAN_SECONDS - 30 * 60) * 1000),
        quotes: [{ item: HERB, quote: previousQuote(180) }]
      },
      existingSeries: [{ itemId: 1, points: [seriesPoint(SCAN_SECONDS - 30 * 60, 180)] }]
    }));
    expect(plan.breadth).toBe(0);
    expect(plan.staleCount).toBe(1);
    const stale = plan.signals.find((row) => row.itemId === 1)?.data.signal;
    expect(stale?.stale).toBe(true);
    expect(stale?.sellPrice).toBe(180);
  });

  it("anchors the phase on the persisted first observation", () => {
    const plan = buildGenerationPlan(input({
      phaseOverride: null,
      firstScanAt: new Date((SCAN_SECONDS - 200 * 3600) * 1000),
      series: null
    }));
    // Breadth is one item, so the ignition breadth floor still wins. The
    // anchor is proven separately: the same age with breadth >= 800 would
    // be steady, and the signal carries the resolved date.
    expect(plan.phase).toBe("ignition");
    expect(plan.firstScanAt.getTime()).toBe((SCAN_SECONDS - 200 * 3600) * 1000);
  });
});
