// Buying the cheapest listing of an item makes the session's scan data a
// lie about that item, and the deal radar reads the scan as its record of
// what is listed right now. Only a full rescan ever rewrote it, so a bought
// deal kept reappearing in the radar at the price it no longer had.
//
// The buy path is the one moment in a session that knows a listing is gone,
// so these tests pin that it writes the correction -- and that it writes it
// from the rows still on the list rather than guessing.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const MAGEWEAVE = 4338;
const LINEN = 2589;
const MED7 = 110000; // median of the closes below; the radar's reference price

// 80000 is 27% under the reference, so it is a deal; the discount gate sits
// at 93500, which is what makes the second listing's price decisive.
const CLOSES = [100000, 110000, 120000];

type Listing = { itemId: number; name: string; count: number; buyout: number };

function listing(unitPrice: number, itemId = MAGEWEAVE, name = "Mageweave Cloth"): Listing {
  return { itemId, name, count: 10, buyout: unitPrice * 10 };
}

function page(options?: { numAuctions?: number; extraScan?: unknown[] }): WowLua {
  const lua = loadAddon();
  lua.setScan([
    {
      itemId: MAGEWEAVE, name: "Mageweave Cloth",
      minPrice: 80000, numAuctions: options?.numAuctions ?? 6
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

// Search, then buy the cheapest row -- which is row 1, because the results
// list defaults to ascending unit price.
function buyCheapest(lua: WowLua, listings: Listing[]) {
  lua.search("Mageweave", listings);
  lua.buyRow(1);
}

describe("a purchase corrects the scan the radar reads", () => {
  it("leaves the cheapest surviving listing as the item's new minimum", () => {
    const lua = page();
    // Two survivors, so "the cheapest one left" and "one of the ones left"
    // are different answers.
    buyCheapest(lua, [listing(80000), listing(90000), listing(85000)]);
    expect(lua.scanMin(MAGEWEAVE)).toBe(85000);
    // Still 22% under the reference, so it stays on the radar -- at the
    // price a player would actually pay now.
    lua.findDeals();
    expect(lua.names()).toEqual(["Mageweave Cloth"]);
    expect(lua.cell(1, 3)).toBe("8金 50银");
  });

  it("drops the item once the surviving price no longer clears the gate", () => {
    const lua = page();
    // 95000 is 14% under a reference of 110000: short of the 15% the radar
    // requires, so what is left is not a deal any more.
    buyCheapest(lua, [listing(80000), listing(95000)]);
    expect(lua.scanMin(MAGEWEAVE)).toBe(95000);
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("forgets the item entirely when its last listing is the one bought", () => {
    const lua = page();
    buyCheapest(lua, [listing(80000)]);
    // Every number in the entry described a book that no longer exists, and
    // a zeroed minimum would read as "free" on the tooltip.
    expect(lua.scanned(MAGEWEAVE)).toBe(false);
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("counts the bought listing out of the book's depth", () => {
    // Three auctions is exactly the liquidity floor, so buying one has to
    // take the item off the radar even though the price still qualifies.
    const lua = page({ numAuctions: 3 });
    buyCheapest(lua, [listing(80000), listing(85000)]);
    expect(lua.scanAuctions(MAGEWEAVE)).toBe(2);
    lua.findDeals();
    expect(lua.names()).toEqual([]);
  });

  it("reprices from the bought item's own listings, not the whole result set", () => {
    const lua = page({
      extraScan: [{ itemId: LINEN, name: "Linen Cloth", minPrice: 80000, numAuctions: 6 }]
    });
    // A name search matches on substring, so unrelated items share the
    // result list -- and here the unrelated one is cheaper than the
    // surviving Mageweave, so a reprice that ignored item identity would
    // hand Mageweave the Linen price.
    buyCheapest(lua, [listing(80000), listing(85000), listing(82000, LINEN, "Linen Cloth")]);
    expect(lua.scanMin(MAGEWEAVE)).toBe(85000);
    // Only the purchase is knowledge about the book; the other item's entry
    // is still whatever the last scan saw.
    expect(lua.scanMin(LINEN)).toBe(80000);
    expect(lua.scanAuctions(LINEN)).toBe(6);
  });

  it("changes nothing when the listing moved before the click landed", () => {
    const lua = page();
    lua.search("Mageweave", [listing(80000), listing(85000)]);
    lua.repriceListing(1, 990000); // someone else bought it and a dearer one took the slot
    lua.buyRow(1);
    expect(lua.lastChat()).toContain("挂单已变化");
    expect(lua.scanMin(MAGEWEAVE)).toBe(80000);
    expect(lua.scanAuctions(MAGEWEAVE)).toBe(6);
  });
});
