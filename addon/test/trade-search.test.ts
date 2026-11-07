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

  it("treats a Unicode-space-only query as empty", () => {
    const lua = openPage();
    lua.exec(`
      WowTest.pendingBrowse = {}
      local trade = WowTest.ns.tradeFrame()
      trade.searchBox:SetText("\\227\\128\\128")
      WowTest.clickButton(WowTest.ns.L.SEARCH)
    `);
    // No scan hit, no browse: an empty query is a no-op in both runtimes.
    expect(lua.eval("WowTest.ah.browse")).toBeNull();
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

  it("discards an in-flight answer and sends the newest query", () => {
    const lua = loadAddon();
    lua.setScan([LINEN]);
    lua.openTab();
    lua.exec(`
      WowTest.sentBrowse = {}
      C_AuctionHouse.SendBrowseQuery = function(query)
        WowTest.sentBrowse[#WowTest.sentBrowse + 1] = query.searchString
      end
      WowTest.ah.itemKeys[111] = { itemID = 111, itemName = "Arcane Crystal Growth", isCommodity = false }
      WowTest.ah.itemKeys[222] = { itemID = 222, itemName = "Arcane Crystal", isCommodity = false }
      WowTest.ah.browse = {
        { itemKey = C_AuctionHouse.MakeItemKey(111), minPrice = 100 },
        { itemKey = C_AuctionHouse.MakeItemKey(222), minPrice = 500 }
      }
      local trade = WowTest.ns.tradeFrame()
      trade.searchBox:SetText("arcane crystal growth")
      WowTest.clickButton(WowTest.ns.L.SEARCH)
      trade.searchBox:SetText("arcane crystal")
      WowTest.clickButton(WowTest.ns.L.SEARCH)
    `);
    // The second search is queued, not sent: only one browse is in flight.
    expect(lua.value("WowTest.sentBrowse")).toEqual(["arcane crystal growth"]);
    // The first answer arrives, is discarded, and the queued query is sent.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_BROWSE_RESULTS_UPDATED')");
    expect(lua.value("WowTest.sentBrowse")).toEqual(["arcane crystal growth", "arcane crystal"]);
    // The second answer is scored against the second query: exact "Arcane
    // Crystal" wins over the prefix, where the stale query would have
    // opened "Arcane Crystal Growth".
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_BROWSE_RESULTS_UPDATED')");
    expect(targetItemId(lua)).toBe(222);
  });

  it("fails instead of opening an arbitrary row when nothing matches", () => {
    const lua = loadAddon();
    lua.setScan([LINEN]);
    lua.openTab();
    lua.exec(`
      C_AuctionHouse.SendBrowseQuery = function() end
      WowTest.ah.itemKeys[111] = { itemID = 111, itemName = "Arcane Crystal", isCommodity = false }
      WowTest.ah.browse = {
        { itemKey = C_AuctionHouse.MakeItemKey(111), minPrice = 100 }
      }
      local trade = WowTest.ns.tradeFrame()
      trade.searchBox:SetText("zzzz")
      WowTest.clickButton(WowTest.ns.L.SEARCH)
      WowTest.fireEvent('AUCTION_HOUSE_BROWSE_RESULTS_UPDATED')
    `);
    expect(lua.eval("WowTest.searchQuery == nil")).toBe(true);
    expect(lua.anyChat("搜索失败")).toBe(true);
  });
});
