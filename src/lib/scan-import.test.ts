import { describe, expect, it } from "vitest";
import type { AddonScanItem } from "@/lib/addon-scan";
import { ensureScanItems } from "./scan-import";

function scanItem(partial: Partial<AddonScanItem> & Pick<AddonScanItem, "itemId" | "name">): AddonScanItem {
  return {
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    marketType: "commodity",
    priced: true,
    minPrice: 90,
    marketPrice: 100,
    sellPrice: 105,
    p5Price: 92,
    quantity: 5,
    numAuctions: 2,
    sellerCount: 2,
    sellersInvisible: false,
    ownerVisible: true,
    sellerHHI: null,
    topSellerShare: null,
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    historySamples: null,
    historySpanHours: null,
    tierTruncated: false,
    tiers: [{ p: 90, q: 5 }],
    expiring: { soon: 0, mid: 0, late: 0 },
    vendorPrice: 0,
    ...partial
  };
}

function existing(partial: Partial<{
  itemId: number; name: string; quality: string; category: string; subCategory: string;
  vendorPrice: number | null; catalogSource: string;
}> = {}) {
  return {
    itemId: 1,
    name: "梦叶草",
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    vendorPrice: null,
    catalogSource: "scan",
    ...partial
  };
}

describe("ensureScanItems", () => {
  it("creates every item when the store is empty", () => {
    const items = [scanItem({ itemId: 1, name: "梦叶草" }), scanItem({ itemId: 2, name: "魔铁矿石" })];
    const diff = ensureScanItems(items, []);
    expect(diff.creates.map((row) => row.itemId)).toEqual([1, 2]);
    expect(diff.creates.every((row) => row.catalogSource === "scan")).toBe(true);
    expect(diff.updates).toEqual([]);
  });

  it("never writes a catalogue-owned row", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 1, name: "梦叶草·新译名", quality: "rare", vendorPrice: 120 })],
      [existing({ catalogSource: "wuxianwow.com", name: "梦叶草", quality: "common", vendorPrice: 0 })]
    );
    expect(diff.creates).toEqual([]);
    expect(diff.updates).toEqual([]);
  });

  it("updates a scan-owned row when the client resolves a field", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 1, name: "梦叶草", quality: "rare", category: "Trade Goods", subCategory: "Herb", vendorPrice: 120 })],
      [existing({ quality: "unknown", category: "unknown", subCategory: "unknown", vendorPrice: null })]
    );
    expect(diff.updates).toEqual([{
      itemId: 1,
      data: { name: "梦叶草", quality: "rare", category: "Trade Goods", subCategory: "Herb", vendorPrice: 120 }
    }]);
  });

  it("never lets a lazy-load miss erase a known class, quality, name or price", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 1, name: "", quality: "unknown", category: "unknown", subCategory: "unknown", vendorPrice: 0 })],
      [existing({ name: "梦叶草", quality: "rare", category: "Trade Goods", subCategory: "Herb", vendorPrice: 120 })]
    );
    expect(diff.updates).toEqual([]);
  });

  it("keeps an unresolved create's vendor price unknown, not zero", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 700, name: "", quality: "unknown", category: "unknown", subCategory: "unknown", vendorPrice: 0 })],
      []
    );
    expect(diff.creates).toEqual([{
      itemId: 700,
      name: "#700",
      quality: "unknown",
      category: "unknown",
      subCategory: "unknown",
      vendorPrice: null,
      catalogSource: "scan"
    }]);
  });

  it("keeps a resolved zero as unsellable", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 7, name: "精金矿石", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 0 })],
      []
    );
    expect(diff.creates[0].vendorPrice).toBe(0);
  });

  it("replaces a placeholder once the client loads the real name", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 700, name: "精金矿石", subCategory: "Metal & Stone", vendorPrice: 50 })],
      [existing({ itemId: 700, name: "#700", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 50 })]
    );
    expect(diff.updates).toEqual([{
      itemId: 700,
      data: { name: "精金矿石", quality: "common", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 50 }
    }]);
  });

  it("creates an item row for demand-only entries so a bid-only market stays visible", () => {
    const diff = ensureScanItems(
      [scanItem({ itemId: 700, name: "Bid Only", priced: false, minPrice: 0, marketPrice: 0, sellPrice: 0, p5Price: 0, quantity: 0, numAuctions: 0, sellerCount: 0, bidOnlyCount: 2, highestBid: 500, tiers: [] })],
      []
    );
    expect(diff.creates[0]).toMatchObject({ itemId: 700, name: "Bid Only", catalogSource: "scan" });
  });
});
