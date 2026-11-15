// The scan is an immutable observation: the terminal rejects a second book
// with the same scannedAt, and the plan identity names that epoch. A
// purchase is state, not a new observation -- rewriting the stored book
// would let one epoch mean two different market states.
//
// The live search table still refreshes after a buy; that is a UI
// observation, and it no longer leaks into the scan the plan reads.

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
  // The journal entry happens on the client's confirmation, not on the
  // optimistic click.
  if (confirm) lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
}

describe("a purchase never rewrites the scan observation", () => {
  it("leaves the bought item's scan entry byte for byte unchanged", () => {
    const lua = page();
    const before = lua.value(`WoWderhoiAH_ScanData.items[${MAGEWEAVE}]`);
    buyCheapest(lua, [listing(80000), listing(90000), listing(85000)]);
    expect(lua.value(`WoWderhoiAH_ScanData.items[${MAGEWEAVE}]`)).toEqual(before);
  });

  it("leaves every other item's scan entry alone", () => {
    const lua = page({
      extraScan: [{
        itemId: LINEN, name: "Linen Cloth", minPrice: 80000, numAuctions: 6,
        sellers: 3, quantity: 10, tiers: [{ p: 80000, q: 10 }]
      }]
    });
    const before = lua.value(`WoWderhoiAH_ScanData.items[${LINEN}]`);
    buyCheapest(lua, [listing(80000), listing(85000)]);
    expect(lua.value(`WoWderhoiAH_ScanData.items[${LINEN}]`)).toEqual(before);
  });

  it("keeps the scan epoch and total", () => {
    const lua = page();
    const scannedAt = lua.number("WoWderhoiAH_ScanData.scannedAt");
    const total = lua.number("WoWderhoiAH_ScanData.total");
    buyCheapest(lua, [listing(80000), listing(85000)]);
    expect(lua.number("WoWderhoiAH_ScanData.scannedAt")).toBe(scannedAt);
    expect(lua.number("WoWderhoiAH_ScanData.total")).toBe(total);
  });

  it("changes nothing when the listing moved before the click landed", () => {
    const lua = page();
    const before = lua.value(`WoWderhoiAH_ScanData.items[${MAGEWEAVE}]`);
    lua.search("Mageweave", [listing(80000), listing(85000)]);
    lua.repriceListing(1, 990000);
    lua.buyRow(1);
    expect(lua.lastChat()).toContain("价格已变化");
    expect(lua.value(`WoWderhoiAH_ScanData.items[${MAGEWEAVE}]`)).toEqual(before);
  });
});

describe("the search result table still follows the client", () => {
  it("re-runs the search and shows the surviving listings", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000), listing(90000), listing(85000)]);
    // The server now answers with the two listings the purchase left.
    lua.exec(`
      WowTest.pendingItemResults[${MAGEWEAVE}] = {
        { itemKey = C_AuctionHouse.MakeItemKey(${MAGEWEAVE}, 0, 0, 0), auctionID = 6101,
          quantity = 10, itemLink = "|Hitem:${MAGEWEAVE}:0:0:0|h[Mageweave Cloth]|h",
          minBid = 85000, buyoutAmount = 85000 },
        { itemKey = C_AuctionHouse.MakeItemKey(${MAGEWEAVE}, 0, 0, 0), auctionID = 6102,
          quantity = 10, itemLink = "|Hitem:${MAGEWEAVE}:0:0:0|h[Mageweave Cloth]|h",
          minBid = 90000, buyoutAmount = 90000 }
      }
    `);
    lua.advance(1);
    expect(lua.rowCount()).toBe(2);
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
