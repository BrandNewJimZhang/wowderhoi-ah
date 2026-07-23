import { describe, expect, it } from "vitest";
import type { AddonScanItem } from "@/lib/addon-scan";
import { diffScanItems } from "./scan-import";

function scanItem(partial: Partial<AddonScanItem> & Pick<AddonScanItem, "itemId" | "name">): AddonScanItem {
  return {
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    minPrice: 90,
    marketPrice: 100,
    quantity: 5,
    numAuctions: 2,
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
    const diff = diffScanItems(items, [{ itemId: 1, name: "梦叶草", quality: "uncommon", vendorPrice: 0 }]);
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
      { itemId: 1, name: "梦叶草", quality: "common", vendorPrice: 0 },
      { itemId: 2, name: "魔铁矿石", quality: "common", vendorPrice: 0 },
      { itemId: 3, name: "碎骨头", quality: "common", vendorPrice: 0 },
      { itemId: 4, name: "厚皮", quality: "common", vendorPrice: 0 }
    ]);
    expect(diff.creates).toEqual([]);
    expect(diff.updates.map((update) => update.itemId)).toEqual([2, 3, 4]);
    expect(diff.updates[0].data).toEqual({ name: "魔铁矿石·新译名", quality: "common", vendorPrice: 0 });
    expect(diff.updates[1].data).toEqual({ name: "碎骨头", quality: "poor", vendorPrice: 0 });
    expect(diff.updates[2].data).toEqual({ name: "厚皮", quality: "common", vendorPrice: 120 });
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
