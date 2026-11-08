import { describe, expect, it } from "vitest";
import type { AddonScanItem } from "@/lib/addon-scan";
import { diffScanItems } from "./scan-import";

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

describe("diffScanItems", () => {
  it("creates every item when the store is empty", () => {
    const items = [scanItem({ itemId: 1, name: "梦叶草" }), scanItem({ itemId: 2, name: "魔铁矿石" })];
    const diff = diffScanItems(items, []);
    expect(diff.creates.map((row) => row.itemId)).toEqual([1, 2]);
    expect(diff.updates).toEqual([]);
  });

  it("emits neither create nor update for unchanged known items", () => {
    const items = [scanItem({ itemId: 1, name: "梦叶草", quality: "uncommon" })];
    const diff = diffScanItems(items, [{ itemId: 1, name: "梦叶草", quality: "uncommon", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }]);
    expect(diff.creates).toEqual([]);
    expect(diff.updates).toEqual([]);
  });

  it("updates only items whose name, quality, or vendor price changed", () => {
    const items = [
      scanItem({ itemId: 1, name: "梦叶草" }),
      scanItem({ itemId: 2, name: "魔铁矿石·新译名" }),
      scanItem({ itemId: 3, name: "碎骨头", quality: "poor" }),
      scanItem({ itemId: 4, name: "厚皮", vendorPrice: 120 })
    ];
    const diff = diffScanItems(items, [
      { itemId: 1, name: "梦叶草", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 },
      { itemId: 2, name: "魔铁矿石", quality: "common", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 0 },
      { itemId: 3, name: "碎骨头", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 },
      { itemId: 4, name: "厚皮", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }
    ]);
    expect(diff.creates).toEqual([]);
    expect(diff.updates.map((update) => update.itemId)).toEqual([2, 3, 4]);
    expect(diff.updates[0].data).toEqual({ name: "魔铁矿石·新译名", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 });
    expect(diff.updates[1].data).toEqual({ name: "碎骨头", quality: "poor", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 });
    expect(diff.updates[2].data).toEqual({ name: "厚皮", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 120 });
  });

  it("never lets a lazy-load miss erase a known class", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "梦叶草", category: "unknown", subCategory: "unknown" })],
      [{ itemId: 1, name: "梦叶草", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }]
    );
    expect(diff.updates).toEqual([]);
  });

  it("never lets a lazy-load miss downgrade a known quality", () => {
    // The same unresolved item record that reports an unknown class also
    // reports no quality; "unknown" is a missing read, not a real quality.
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "梦叶草", quality: "unknown" })],
      [{ itemId: 1, name: "梦叶草", quality: "rare", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }]
    );
    expect(diff.updates).toEqual([]);
  });

  it("fills in a quality once the client loads the item record", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "梦叶草", quality: "rare" })],
      [{ itemId: 1, name: "梦叶草", quality: "unknown", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }]
    );
    expect(diff.updates).toEqual([{
      itemId: 1,
      data: { name: "梦叶草", quality: "rare", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }
    }]);
  });

  it("never lets a lazy-load miss reset a known vendor price", () => {
    // An unresolved item record reports vendorPrice 0 as well as an unknown
    // class. That zero is "not loaded yet", not "unsellable".
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "梦叶草", category: "unknown", subCategory: "unknown", vendorPrice: 0 })],
      [{ itemId: 1, name: "梦叶草", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 120 }]
    );
    expect(diff.updates).toEqual([]);
  });

  it("fills in a class once the client loads the item record", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "梦叶草" })],
      [{ itemId: 1, name: "梦叶草", quality: "common", category: "unknown", subCategory: "unknown", vendorPrice: 0 }]
    );
    expect(diff.updates).toEqual([{
      itemId: 1,
      data: { name: "梦叶草", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }
    }]);
  });

  it("never lets a lazy-load miss erase a known name", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 1, name: "", quality: "unknown", category: "unknown", subCategory: "unknown", vendorPrice: 0 })],
      [{ itemId: 1, name: "梦叶草", quality: "common", category: "Trade Goods", subCategory: "Herb", vendorPrice: 0 }]
    );
    expect(diff.updates).toEqual([]);
  });

  it("names an unloaded item with a stable placeholder until the client loads it", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 700, name: "", quality: "unknown", category: "unknown", subCategory: "unknown", vendorPrice: 0 })],
      []
    );
    expect(diff.creates).toEqual([{
      itemId: 700,
      name: "#700",
      quality: "unknown",
      category: "unknown",
      subCategory: "unknown",
      vendorPrice: 0
    }]);
  });

  it("replaces the placeholder once the client loads the real name", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 700, name: "精金矿石", subCategory: "Metal & Stone", vendorPrice: 50 })],
      [{ itemId: 700, name: "#700", quality: "common", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 50 }]
    );
    expect(diff.updates).toEqual([{
      itemId: 700,
      data: { name: "精金矿石", quality: "common", category: "Trade Goods", subCategory: "Metal & Stone", vendorPrice: 50 }
    }]);
  });

  it("creates an item row for demand-only entries so a bid-only market stays visible", () => {
    const diff = diffScanItems(
      [scanItem({ itemId: 700, name: "Bid Only", priced: false, minPrice: 0, marketPrice: 0, sellPrice: 0, p5Price: 0, quantity: 0, numAuctions: 0, sellerCount: 0, bidOnlyCount: 2, highestBid: 500, tiers: [] })],
      []
    );
    expect(diff.creates).toEqual([{
      itemId: 700,
      name: "Bid Only",
      quality: "common",
      category: "Trade Goods",
      subCategory: "Herb",
      vendorPrice: 0
    }]);
  });

  it("carries the full column set on creates", () => {
    const diff = diffScanItems([scanItem({ itemId: 7, name: "精金矿石", subCategory: "Metal & Stone", vendorPrice: 50 })], []);
    expect(diff.creates[0]).toEqual({
      itemId: 7,
      name: "精金矿石",
      quality: "common",
      category: "Trade Goods",
      subCategory: "Metal & Stone",
      vendorPrice: 50
    });
  });
});
