// The Forever scanner reads C_AuctionHouse.GetReplicateItemInfo instead of
// the legacy list API. These tests pin what pipeline v4 promises: the
// replicate fields land in the SavedVariables shape the terminal imports,
// the order book survives, demand (bid-only) is retained, and the inferred
// flow between two scans never counts a natural expiry as a sale.

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

describe("forever replicate scan v4", () => {
  it("aggregates listings into the same scan shape the terminal imports", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 20000, quality: 1, vendorP: 100 },
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 40000, quality: 1, vendorP: 100 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.dataVersion")).toBe(4);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].marketPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].numAuctions")).toBe(2);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].vendorP")).toBe(100);
    expect(lua.number("WoWderhoiAH_ScanData.total")).toBe(2);
    const p10 = lua.number(
      "WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[2589].p10[1]"
    );
    expect(p10).toBe(1000);
    expect(lua.number("WowTest.savedCount")).toBeGreaterThan(0);
  });

  it("keeps the top of the price ladder so a multi-unit purchase can be priced", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 10000 },
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 20000 },
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 30000 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].p")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].q")).toBe(10);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[3].p")).toBe(3000);
  });

  it("counts distinct sellers and falls back to listings when owners are hidden", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 1, buyout: 1000, owner: "Alice" },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1200, owner: "Bob" },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1400, owner: "Alice" }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].sellers")).toBe(2);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].sellersInvisible")).toBe(false);

    const hidden = auctionPage();
    hidden.runScan([
      { itemId: 2589, name: "Linen", count: 1, buyout: 1000, sellerUnknown: true },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1200, sellerUnknown: true }
    ]);
    expect(hidden.number("WoWderhoiAH_ScanData.items[2589].sellers")).toBe(2);
    expect(hidden.eval("WoWderhoiAH_ScanData.items[2589].sellersInvisible")).toBe(true);
  });

  it("retains bid-only listings as a demand signal instead of dropping them", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 700, name: "Bid Only", count: 1, buyout: 0, bid: 500 },
      { itemId: 701, name: "Buyout", count: 1, buyout: 500 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[700].bidOnly")).toBe(1);
    expect(lua.number("WoWderhoiAH_ScanData.items[700].minPrice")).toBe(0);
    expect(lua.number("WoWderhoiAH_ScanData.bids[700].highest")).toBe(500);
    expect(lua.number("WoWderhoiAH_ScanData.items[701].minPrice")).toBe(500);
  });

  it("infers disappeared quantity between two scans and keeps it a lower edge", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 7200 }
    ]);
    lua.exec("WowTest.advance(900)");
    // 40 units vanished from the same price tier; the listing had two hours
    // left before the scan, so it cannot have expired in fifteen minutes.
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 6300 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSold")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].supplyGrowth")).toBe(0);
  });

  it("does not count a disappearance as a sale when the listing was about to expire", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 120 }
    ]);
    lua.exec("WowTest.advance(900)");
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 60 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSold")).toBe(0);
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
