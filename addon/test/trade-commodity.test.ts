// Commodities are the half of the modern auction house the old list API
// never had: offers are anonymous groups sold by quantity, not auctions with
// an index and a buyout. The page must price them per unit, and the buy
// button must go through the client's quantity purchase instead of
// PlaceBid(auctionID).

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const LINEN = 2589;

type Offer = { itemId: number; name: string; count: number; buyout: number; commodity: true };

function offer(unitPrice: number, count = 20): Offer {
  return { itemId: LINEN, name: "Linen Cloth", count, buyout: unitPrice * count, commodity: true };
}

function page(): WowLua {
  const lua = loadAddon();
  lua.setScan([{ itemId: LINEN, name: "Linen Cloth", minPrice: 100, numAuctions: 6 }]);
  lua.setPoints([{ itemId: LINEN, closes: [90, 100, 110] }]);
  lua.openTab();
  return lua;
}

describe("commodity price book", () => {
  it("prices each offer per unit and labels the action as a market buy", () => {
    const lua = page();
    lua.search("Linen", [offer(200), offer(100)]);
    // Cheapest unit price first, same as item auctions.
    expect(lua.rowName(1)).toBe("Linen Cloth");
    expect(lua.cell(1, 2)).toBe("20");
    expect(lua.cell(1, 3)).toBe("1银 00铜");
    expect(lua.cell(1, 4)).toBe("20银 00铜");
    expect(lua.eval("WowTest.ns.L.BUY_MARKET")).toBe("购买*");
  });

  it("starts a quantity purchase at the verified market price", () => {
    const lua = page();
    lua.search("Linen", [offer(100)]);
    lua.buyRow(1);
    expect(lua.number("WowTest.commodityPurchase.itemId")).toBe(LINEN);
    expect(lua.number("WowTest.commodityPurchase.quantity")).toBe(20);
    // The client's confirmation dialog owns the final total; the addon must
    // not pretend the click completed a purchase.
    expect(lua.lastChat()).toContain("确认实际总价");
  });

  it("estimates a quantity purchase from the whole offer ladder, not the clicked row", () => {
    const lua = page();
    lua.search("Linen", [offer(100, 20), offer(200, 20)]);
    // Row 2 shows 20 units at 200c (4000c total), but a market buy of 20
    // units fills from the cheaper offer first: 20 x 100c.
    lua.buyRow(2);
    expect(lua.number("WowTest.commodityPurchase.quantity")).toBe(20);
    expect(lua.lastChat()).toContain("2000c");
  });

  it("aborts when the market price moved before the click landed", () => {
    const lua = page();
    lua.search("Linen", [offer(100)]);
    lua.exec("WowTest.ah.commodityResults[2589][1].unitPrice = 999");
    lua.buyRow(1);
    expect(lua.lastChat()).toContain("价格已变化");
    expect(lua.eval("WowTest.commodityPurchase == nil")).toBe(true);
  });
});
