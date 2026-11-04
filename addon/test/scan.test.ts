// The Forever scanner reads C_AuctionHouse.GetReplicateItemInfo instead of
// the legacy list API. These tests pin the two things the old scanner could
// not prove offline: the replicate fields land in the SavedVariables shape
// the terminal imports, and the per-frame cursor never skips a row.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

function auctionPage(): WowLua {
  const lua = loadAddon();
  lua.openTab(); // AUCTION_HOUSE_SHOW: the scanner refuses to run without it
  return lua;
}

function countItems(lua: WowLua): number {
  return lua.number(
    "(function() local n = 0 for _ in pairs(WoWderhoiAH_ScanData.items) do n = n + 1 end return n end)()"
  );
}

describe("forever replicate scan", () => {
  it("aggregates listings into the same scan shape the terminal imports", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 20000, quality: 1, vendorP: 100 },
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 40000, quality: 1, vendorP: 100 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.dataVersion")).toBe(3);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].marketPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].numAuctions")).toBe(2);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].vendorP")).toBe(100);
    expect(lua.number("WoWderhoiAH_Points[2589][1].c")).toBe(1000);
  });

  it("does not skip a row when the per-frame budget boundary falls mid-book", () => {
    const lua = auctionPage();
    // PROCESS_PER_FRAME is 200 and the stub clock never trips the time
    // budget, so 250 rows span two OnUpdate calls. The old cursor advanced
    // after the budget check and dropped row 201 at exactly this boundary.
    const items = Array.from({ length: 250 }, (_, index) => ({
      itemId: 10000 + index,
      name: `Item ${index}`,
      count: 1,
      buyout: 100 + index
    }));
    lua.runScan(items);
    expect(countItems(lua)).toBe(250);
  });

  it("skips bid-only listings, which have no buyout a buyer can pay", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 700, name: "Bid Only", count: 1, buyout: 0 },
      { itemId: 701, name: "Buyout", count: 1, buyout: 500 }
    ]);
    expect(lua.scanned(700)).toBe(false);
    expect(lua.scanned(701)).toBe(true);
  });

  it("does not consume a stale replicate count from an item search", () => {
    const lua = auctionPage();
    // The client still holds the previous replicate response. An item
    // search firing while the new response is in flight must not make the
    // scanner process that stale book.
    lua.exec("WowTest.ah.replicate = { { itemId = 1, name = 'Old', count = 1, buyout = 100 } }");
    lua.exec("WowTest.ns.startScan()");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_NEW_RESULTS_RECEIVED', { itemID = 2589, itemLevel = 0, itemSuffix = 0, battlePetSpeciesID = 0 })");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(true);
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("aborts loudly when the client never answers a replicate request", () => {
    const lua = auctionPage();
    lua.exec("WowTest.ns.startScan()");
    lua.exec("WowTest.runTimers()");
    expect(lua.lastChat()).toContain("超时");
  });
});
