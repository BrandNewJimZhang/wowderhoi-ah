// The search box resolves a typed query against the session scan first, then
// against the server's browse answer. A query must reach the item the player
// named: by id, by every whitespace-separated token, and by the closest name
// in a server page rather than whichever row was cheapest.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const LINEN = {
  itemId: 2589, name: "Linen", minPrice: 800, sellP: 1000,
  numAuctions: 4, sellers: 2, quantity: 4, itemClass: "Trade Goods",
  tiers: [{ p: 800, q: 4 }]
};
const LINEN_CLOTH = {
  itemId: 2590, name: "Linen Cloth", minPrice: 900, sellP: 1100,
  numAuctions: 4, sellers: 2, quantity: 4, itemClass: "Trade Goods",
  tiers: [{ p: 900, q: 4 }]
};
const MAGEWEAVE = {
  itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
  numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
  tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
};

function openPage(): WowLua {
  const lua = loadAddon();
  lua.setScan([LINEN, LINEN_CLOTH, MAGEWEAVE]);
  lua.openTab();
  return lua;
}

const targetItemId = (lua: WowLua) => lua.eval("WowTest.searchQuery.itemKey.itemID");

describe("search resolution", () => {
  it("opens the item addressed by its numeric id", () => {
    const lua = openPage();
    // The server listing names a different item: only the id path can reach
    // Mageweave here, and the old substring search would fall through to it.
    lua.search("4338", [{ itemId: 2589, name: "Linen", count: 1, buyout: 100 }]);
    expect(targetItemId(lua)).toBe(4338);
  });

  it("accepts an item hyperlink id", () => {
    const lua = openPage();
    lua.search("item:4338", [{ itemId: 2589, name: "Linen", count: 1, buyout: 100 }]);
    expect(targetItemId(lua)).toBe(4338);
  });

  it("matches every token in the name, in any order", () => {
    const lua = openPage();
    lua.search("cloth mage", [{ itemId: 2589, name: "Linen", count: 1, buyout: 100 }]);
    expect(targetItemId(lua)).toBe(4338);
  });

  it("prefers an exact name over a longer prefix match", () => {
    const lua = openPage();
    lua.search("linen", [{ itemId: 2590, name: "Linen Cloth", count: 1, buyout: 100 }]);
    expect(targetItemId(lua)).toBe(2589);
  });
});

describe("browse fallback", () => {
  it("opens the closest name in the server page, not the cheapest row", () => {
    const lua = loadAddon();
    lua.setScan([LINEN, MAGEWEAVE]);
    lua.openTab();
    lua.exec(`
      WowTest.ah.itemKeys[111] = { itemID = 111, itemName = "Arcane Crystal Growth", isCommodity = false }
      WowTest.ah.itemKeys[222] = { itemID = 222, itemName = "Arcane Crystal", isCommodity = false }
      WowTest.pendingBrowse = {
        { itemKey = C_AuctionHouse.MakeItemKey(111), minPrice = 100 },
        { itemKey = C_AuctionHouse.MakeItemKey(222), minPrice = 500 }
      }
      local trade = WowTest.ns.tradeFrame()
      trade.searchBox:SetText("arcane crystal")
      WowTest.clickButton(WowTest.ns.L.SEARCH)
    `);
    expect(targetItemId(lua)).toBe(222);
  });
});
