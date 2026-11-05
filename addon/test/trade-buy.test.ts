// Buying the cheapest listing of an item makes the session's scan data a
// lie about that item, and the cockpit reads the scan as its record of what
// is listed right now. Only a full rescan ever rewrote it, so a bought
// listing kept reappearing at a price nobody could pay.
//
// The buy path is the one moment in a session that knows a listing is gone,
// so these tests pin that it rebuilds the ladder from the rows still on the
// list -- and that a confirmed purchase becomes a journal fact.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const MAGEWEAVE = 4338;
const LINEN = 2589;
const CLOSES = [100000, 105000, 110000, 115000, 110000, 110000];

type Listing = { itemId: number; name: string; count: number; buyout: number };

function listing(unitPrice: number, itemId = MAGEWEAVE, name = "Mageweave Cloth"): Listing {
  return { itemId, name, count: 10, buyout: unitPrice * 10 };
}

function page(options?: { numAuctions?: number; phase?: string; extraScan?: unknown[] }): WowLua {
  const lua = loadAddon();
  if (options?.phase) lua.exec(`WoWderhoiAH_Settings.phaseOverride = ${JSON.stringify(options.phase)}`);
  lua.setScan([
    {
      itemId: MAGEWEAVE, name: "Mageweave Cloth", minPrice: 80000, sellP: 110000,
      numAuctions: options?.numAuctions ?? 3, sellers: 3, quantity: 30,
      itemClass: "Trade Goods",
      tiers: [{ p: 80000, q: 10 }, { p: 85000, q: 10 }, { p: 90000, q: 10 }]
    },
    ...(options?.extraScan ?? [])
  ]);
  lua.setPoints([
    { itemId: MAGEWEAVE, closes: CLOSES },
    { itemId: LINEN, closes: CLOSES }
  ]);
  lua.openTab();
  return lua;
}

function buyCheapest(lua: WowLua, listings: Listing[], confirm = true) {
  lua.search("Mageweave", listings);
  lua.buyRow(1);
  // The scan correction and the journal entry both happen on the client's
  // confirmation, not on the optimistic click.
  if (confirm) lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
}

describe("a purchase corrects the scan the cockpit reads", () => {
  it("leaves the cheapest surviving listing as the item's new minimum", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000), listing(90000), listing(85000)]);
    expect(lua.scanMin(MAGEWEAVE)).toBe(85000);
    expect(lua.scanAuctions(MAGEWEAVE)).toBe(2);
    expect(lua.number("WoWderhoiAH_ScanData.items[4338].quantity")).toBe(20);
    expect(lua.number("#WoWderhoiAH_ScanData.items[4338].tiers")).toBe(2);
  });

  it("drops the item once the surviving front leaves no executable edge", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000), listing(90000), listing(85000)]);
    // The sell front is now the cheapest survivor, so buying it to resell
    // at the front has no spread. The old median radar kept showing this;
    // the executable radar must not.
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("forgets the item entirely when its last listing is the one bought", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000)]);
    expect(lua.scanned(MAGEWEAVE)).toBe(false);
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("counts the bought listing out of the book's depth", () => {
    // Wave rules require three buyable listings; buying one leaves two.
    const lua = page({ numAuctions: 3, phase: "wave" });
    buyCheapest(lua, [listing(80000), listing(85000), listing(90000)]);
    expect(lua.scanAuctions(MAGEWEAVE)).toBe(2);
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("leaves every other item's scan entry alone", () => {
    const lua = page({
      extraScan: [{
        itemId: LINEN, name: "Linen Cloth", minPrice: 80000, numAuctions: 6,
        sellers: 3, quantity: 10, tiers: [{ p: 80000, q: 10 }]
      }]
    });
    buyCheapest(lua, [listing(80000), listing(85000)]);
    expect(lua.scanMin(MAGEWEAVE)).toBe(85000);
    expect(lua.scanMin(LINEN)).toBe(80000);
    expect(lua.scanAuctions(LINEN)).toBe(6);
  });

  it("changes nothing when the listing moved before the click landed", () => {
    const lua = page();
    lua.search("Mageweave", [listing(80000), listing(85000)]);
    lua.repriceListing(1, 990000);
    lua.buyRow(1);
    expect(lua.lastChat()).toContain("价格已变化");
    expect(lua.scanMin(MAGEWEAVE)).toBe(80000);
    expect(lua.scanAuctions(MAGEWEAVE)).toBe(3);
  });
});

describe("the post-purchase front uses the scanner's own rule", () => {
  it("measures an item auction's depth in listings, not units", () => {
    const lua = loadAddon();
    lua.setScan([
      {
        itemId: MAGEWEAVE, name: "Mageweave Cloth", minPrice: 100, sellP: 300,
        numAuctions: 4, sellers: 4, quantity: 6, itemClass: "Armor",
        tiers: [{ p: 100, q: 1 }, { p: 200, q: 3 }, { p: 300, q: 1 }, { p: 400, q: 1 }]
      }
    ]);
    lua.setPoints([{ itemId: MAGEWEAVE, closes: CLOSES }]);
    lua.openTab();
    lua.search("Mageweave", [
      { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 1, buyout: 100 },
      { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 3, buyout: 600 },
      { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 1, buyout: 300 },
      { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 1, buyout: 400 }
    ]);
    lua.buyRow(1);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    // Three listings survive. The by-listing front is the third cheapest
    // (400); a quantity-weighted front would stop inside the 3-stack at
    // 200, pricing the same book two different ways.
    expect(lua.number("WoWderhoiAH_ScanData.items[4338].sellP")).toBe(400);
  });
});

describe("a confirmed purchase becomes a ledger fact", () => {
  it("records the item auction on AUCTION_HOUSE_PURCHASE_COMPLETED", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000), listing(85000)], false);
    // PlaceBid is only a request; the completion event is the confirmation.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[4338].qty")).toBe(10);
    expect(lua.number("WowTest.ns.Ledger.positions()[4338].cost")).toBe(800000);
    expect(lua.anyChat("已购买")).toBe(true);
  });

  it("does not invent a ledger entry when the client never confirms", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000), listing(85000)], false);
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(0);
    expect(lua.anyChat("未确认")).toBe(true);
  });

  it("records a commodity purchase at the ladder cost the client was shown", () => {
    const lua = page();
    lua.search("Linen", [
      { itemId: LINEN, name: "Linen Cloth", count: 20, buyout: 2000, commodity: true }
    ]);
    lua.buyRow(1);
    // The auction event settles after a short wait: COMMODITY_PURCHASED is
    // the event that reports the actual fill, and this path is the fallback
    // for clients that only fire the auction one.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(20);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(2000);
  });
});
