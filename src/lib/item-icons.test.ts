import { describe, expect, it } from "vitest";
import { iconFileName, iconUrl, uniqueIconIds } from "@/lib/item-icons";
import type { CatalogItem } from "@/lib/item-catalog";

function item(itemId: number, iconId: number): CatalogItem {
  return {
    itemId,
    iconId,
    name: `Item ${itemId}`,
    quality: "common",
    category: "商品",
    subCategory: "草药",
    vendorPrice: 0,
    itemLevel: null,
    requiredLevel: null,
    slot: null,
    typeLabel: null
  };
}

describe("item icons", () => {
  it("keys the file by the shared icon id", () => {
    expect(iconFileName(134816)).toBe("134816.webp");
    expect(iconUrl(134816)).toBe("https://wuxianwow.com/data/icons/134816.webp");
  });

  it("downloads each shared icon once", () => {
    expect(uniqueIconIds([item(1, 10), item(2, 10), item(3, 20)])).toEqual([10, 20]);
  });
});
