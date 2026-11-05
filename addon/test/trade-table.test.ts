// The cockpit's table is the only place where column slots, header clicks
// and money formatting exist, and none of it is reachable from the
// Next.js side. These tests drive the shipped Lua through the same entry
// points a player uses -- open the tab, click a header -- and assert on
// the text that lands in the cells.
//
// The radar is produced by Core.lua, so these fixtures also pin the
// executable-profit contract: buyable quantity, ladder price, sell front,
// net profit and fill probability, with vendor arbitrage first.

import { describe, expect, it, beforeEach } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const LINEN = {
  itemId: 2589, name: "Linen Cloth", minPrice: 800, vendorP: 1000,
  numAuctions: 5, sellers: 3, quantity: 5, itemClass: "Trade Goods",
  tiers: [{ p: 800, q: 5 }]
};
const MAGEWEAVE = {
  itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
  numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
  tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
};
const GOLD_ORE = {
  itemId: 3577, name: "Gold Ore", minPrice: 40000, sellP: 52000,
  numAuctions: 9, sellers: 4, quantity: 30, itemClass: "Trade Goods",
  tiers: [{ p: 40000, q: 10 }, { p: 44000, q: 20 }]
};

const SCAN = [LINEN, MAGEWEAVE, GOLD_ORE];
const POINTS = [
  { itemId: MAGEWEAVE.itemId, closes: [10000, 11000, 12000] },
  { itemId: GOLD_ORE.itemId, closes: [50000, 52000, 54000] }
];

// Vendor first (risk-free), then the larger executable net profit.
const BY_NET = ["Linen Cloth [NPC必赚]", "Gold Ore", "Mageweave Cloth"];

function openRadar(options?: { locale?: string }) {
  const lua = loadAddon(options);
  lua.setScan(SCAN);
  lua.setPoints(POINTS);
  lua.openTab();
  return lua;
}

describe("executable-profit radar table", () => {
  let lua: WowLua;
  beforeEach(() => {
    lua = openRadar();
  });

  it("lands on the radar with vendor arbitrage first, then by executable net", () => {
    expect(lua.rowCount()).toBe(3);
    expect(lua.names()).toEqual(BY_NET);
  });

  it("tags the vendor row on the name so no number column carries two meanings", () => {
    expect(lua.rowName(1)).toBe("Linen Cloth [NPC必赚]");
    expect(lua.rowName(2)).toBe("Gold Ore");
  });

  it("gives every column one meaning across all rows", () => {
    expect(lua.header(0)).toBe("物品");
    expect([1, 2, 3, 4, 5].map((slot) => lua.header(slot)))
      .toEqual(["可买", "买价", "建议卖价", "净利", "成交率"]);
    // The in-game budget is the purse; the allocator applies the 50% daily
    // share once. The 1,000,000-copper purse therefore grants 500,000.
    expect(lua.column(1)).toEqual(["5", "6", "29"]);
    // The buy price is the allocated quantity's average, not the full-depth
    // average: Gold Ore's 6 units all cost 40,000 each, and Mageweave's 29
    // are 20 at 8,000 plus 9 at 9,000.
    expect(lua.column(2)).toEqual(["8银 00铜", "4金 00银", "83银 10铜"]);
    expect(lua.column(3)).toEqual(["10银 00铜", "5金 20银", "1金 00银"]);
    // Net of the allocated quantity, priced from the cheap end of the book:
    // the quantity and the profit in a row must describe the same trade.
    // Gold Ore's 6 units all come from the 40,000 tier; Mageweave's 29 are
    // 20 at 8,000 plus 9 at 9,000, not 29 at the 70-unit average.
    expect(lua.column(4)).toEqual(["10银 00铜", "5金 63银", "3金 44银"]);
    expect(lua.column(5)).toEqual(["100%", "100%", "100%"]);
  });

  it("does not show a discount column: the anchor is the sell front, not a median", () => {
    expect([0, 1, 2, 3, 4, 5].map((slot) => lua.header(slot))).not.toContain("折扣");
    expect(lua.header(3)).toBe("建议卖价");
  });
});

describe("column sorting", () => {
  let lua: WowLua;
  beforeEach(() => {
    lua = openRadar();
  });

  it("sorts by buyable quantity", () => {
    lua.clickHeader("可买");
    // Mageweave gets the most allocation; the 5-unit vendor and Gold Ore
    // rows tie and fall back to name order.
    expect(lua.names()).toEqual(["Mageweave Cloth", "Gold Ore", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts by net profit, biggest first", () => {
    lua.clickHeader("净利");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts by suggested sell price, biggest first", () => {
    lua.clickHeader("建议卖价");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts the item column by name, ascending first", () => {
    lua.clickHeader("物品");
    expect(lua.names()).toEqual(["Gold Ore", "Linen Cloth [NPC必赚]", "Mageweave Cloth"]);
  });

  it("opens the buy-price column cheapest-first", () => {
    lua.clickHeader("买价");
    expect(lua.names()).toEqual(["Linen Cloth [NPC必赚]", "Mageweave Cloth", "Gold Ore"]);
  });

  it("reverses on a second click of the same column", () => {
    lua.clickHeader("买价");
    lua.clickHeader("买价");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("marks the sorted column and moves the marker when another is clicked", () => {
    expect(lua.header(4)).toBe("净利");
    lua.clickHeader("净利");
    expect(lua.header(4)).toBe("净利 ▼");
    lua.clickHeader("净利");
    expect(lua.header(4)).toBe("净利 ▲");
    lua.clickHeader("买价");
    expect(lua.header(2)).toBe("买价 ▲");
    expect(lua.header(4)).toBe("净利");
  });

  it("drops the sort when the rows are rebuilt, because the old key no longer describes them", () => {
    lua.clickHeader("物品");
    expect(lua.names()).toEqual(["Gold Ore", "Linen Cloth [NPC必赚]", "Mageweave Cloth"]);
    lua.findDeals();
    expect(lua.header(0)).toBe("物品");
    expect(lua.names()).toEqual(BY_NET);
  });
});

describe("search results table", () => {
  const LISTINGS = [
    { itemId: 858, name: "Lesser Healing Potion", count: 1, buyout: 99 },
    { itemId: 858, name: "Lesser Healing Potion", count: 1, buyout: 100 },
    { itemId: 858, name: "Lesser Healing Potion", count: 1, buyout: 9999 },
    { itemId: 858, name: "Lesser Healing Potion", count: 1, buyout: 10000 },
    { itemId: 858, name: "Lesser Healing Potion", count: 1, buyout: 1234567 },
    { itemId: 858, name: "Lesser Healing Potion", count: 3, buyout: 101 }
  ];

  let lua: WowLua;
  beforeEach(() => {
    lua = openRadar();
    lua.search("Lesser Healing Potion", LISTINGS);
  });

  it("switches the columns with the mode and blanks the slots it does not use", () => {
    expect([1, 2, 3, 4, 5].map((slot) => lua.header(slot)))
      .toEqual(["", "", "数量", "单价", "总价"]);
  });

  it("orders by unit price so a cheap stack cannot hide behind a small total", () => {
    expect(lua.column(3)).toEqual(["3", "1", "1", "1", "1", "1"]);
    expect(lua.column(5)).toEqual(["1银 01铜", "99铜", "1银 00铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });

  it("prints two units at every magnitude, keeping the silver that decides a bait price", () => {
    expect(lua.column(4)).toEqual(["34铜", "99铜", "1银 00铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });

  it("sorts by total price without disturbing the unit column's meaning", () => {
    lua.clickHeader("总价");
    expect(lua.column(5)).toEqual(["99铜", "1银 00铜", "1银 01铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });
});

describe("locale", () => {
  it("takes column labels, money suffixes and sort markers from the locale table", () => {
    const lua = openRadar({ locale: "enUS" });
    expect([0, 1, 2, 3, 4, 5].map((slot) => lua.header(slot))).toEqual([
      "Item", "Buy", "Buy at", "Sell at", "Net", "Fill"
    ]);
    expect(lua.cell(1, 2)).toBe("8s 00c");
    expect(lua.cell(2, 3)).toBe("5g 20s");
    lua.clickHeader("Net");
    expect(lua.header(4)).toBe("Net v");
  });
});
