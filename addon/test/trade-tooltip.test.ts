// Trade rows had no hover handler at all, so the one page in the addon
// dedicated to deciding what to buy was the one place its own price data
// could not be read. These tests pin what a row points the client's tooltip
// at -- the listing under the cursor, not the row's position -- and that
// GUI.lua's price block rides along through the hooks it already installs.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const MAGEWEAVE = 4338;

// Listed expensive-first so the table's default unit-price sort reorders
// them: row 1 then holds auction index 2, and a tooltip keyed off the row's
// position instead of its listing would name the wrong auction.
const LISTINGS = [
  { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 20, buyout: 200000 },
  { itemId: MAGEWEAVE, name: "Mageweave Cloth", count: 20, buyout: 160000 }
];

function tradePage(): WowLua {
  const lua = loadAddon();
  lua.setScan([{ itemId: MAGEWEAVE, name: "Mageweave Cloth", minPrice: 8000, sellP: 11000, numAuctions: 6, sellers: 3, quantity: 10, itemClass: "Trade Goods", tiers: [{ p: 8000, q: 10 }] }]);
  lua.setPoints([{ itemId: MAGEWEAVE, closes: [10000, 11000, 12000] }]);
  lua.openTab();
  return lua;
}

describe("row tooltips", () => {
  it("aims the tooltip at the listing the row shows", () => {
    const lua = tradePage();
    lua.search("Mageweave", LISTINGS);
    lua.hoverRow(1);
    // The modern API has no auction-index tooltip setter: a listing carries
    // its own item link, and the row points the client at that.
    expect(lua.tooltipSource()).toContain("item:4338");
    lua.hoverRow(2);
    expect(lua.tooltipSource()).toContain("item:4338");
  });

  it("carries the price block the four-column table has no room for", () => {
    const lua = tradePage();
    lua.search("Mageweave", LISTINGS);
    lua.hoverRow(1);
    // Routing through the client's own item tooltip is the point: GUI.lua
    // already hooks every tooltip setter, so the scan and history section
    // appends itself with no second code path to keep in step.
    expect(lua.tooltipText()).toContain("最低价");
    expect(lua.tooltipText()).toContain("建议卖价中位");
    expect(lua.tooltipText()).toContain("P10（统计）");
  });

  it("shows the item itself for a deal row, which has no live listing", () => {
    // The radar row is built from scan data, so there is no auction index
    // to point at -- only the item.
    const lua = tradePage();
    lua.hoverRow(1);
    expect(lua.tooltipSource()).toBe(`hyperlink:item:${MAGEWEAVE}`);
    expect(lua.tooltipText()).toContain("最低价");
  });

  it("hides the tooltip when the cursor leaves the row", () => {
    const lua = tradePage();
    lua.hoverRow(1);
    expect(lua.tooltipShown()).toBe(true);
    lua.leaveRow(1);
    expect(lua.tooltipShown()).toBe(false);
  });
});
