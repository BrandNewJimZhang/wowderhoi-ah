// The addon's table is the only place where column slots, header clicks and
// money formatting exist, and none of it is reachable from the Next.js side.
// These tests drive the shipped Lua through the same entry points a player
// uses -- open the tab, click a header -- and assert on the text that lands
// in the cells.

import { describe, expect, it, beforeEach } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

// One vendor deal and two median discounts, with profits, discounts, min
// prices and references that all rank differently, so every column's sort
// produces a distinct order and no assertion passes by coincidence.
const LINEN = { itemId: 2589, name: "Linen Cloth", minPrice: 800, vendorP: 1000, numAuctions: 5 };
const MAGEWEAVE = { itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, numAuctions: 6 };
const GOLD_ORE = { itemId: 3577, name: "Gold Ore", minPrice: 40000, numAuctions: 9 };

const SCAN = [LINEN, MAGEWEAVE, GOLD_ORE];
const POINTS = [
  // med7 = 11000 (lower median of three), so 8000 is a 27% discount.
  { itemId: MAGEWEAVE.itemId, closes: [10000, 11000, 12000] },
  // med7 = 52000, so 40000 is a 23% discount.
  { itemId: GOLD_ORE.itemId, closes: [50000, 52000, 54000] }
];

const BY_PROFIT = ["Linen Cloth [NPC必赚]", "Gold Ore", "Mageweave Cloth"];

function openRadar(options?: { locale?: string }) {
  const lua = loadAddon(options);
  lua.setScan(SCAN);
  lua.setPoints(POINTS);
  lua.openTab();
  return lua;
}

describe("deal radar table", () => {
  let lua: WowLua;
  beforeEach(() => {
    lua = openRadar();
  });

  it("lands on the radar with vendor deals first, then profit descending", () => {
    expect(lua.rowCount()).toBe(3);
    expect(lua.names()).toEqual(BY_PROFIT);
  });

  it("tags the vendor row on the name so no number column carries two meanings", () => {
    expect(lua.rowName(1)).toBe("Linen Cloth [NPC必赚]");
    expect(lua.rowName(2)).toBe("Gold Ore");
  });

  it("gives every column one meaning across all rows", () => {
    expect(lua.header(0)).toBe("物品");
    expect([1, 2, 3, 4].map((slot) => lua.header(slot))).toEqual(["折扣", "利润", "最低价", "参考价"]);
    // Linen's reference is the NPC sell price, the others' is their med7 --
    // different sources, same meaning: what the min price is measured against.
    expect(lua.column(1)).toEqual(["-20%", "-23%", "-27%"]);
    expect(lua.column(2)).toEqual(["2银 00铜", "1金 20银", "30银 00铜"]);
    expect(lua.column(3)).toEqual(["8银 00铜", "4金 00银", "80银 00铜"]);
    expect(lua.column(4)).toEqual(["10银 00铜", "5金 20银", "1金 10银"]);
  });
});

describe("column sorting", () => {
  let lua: WowLua;
  beforeEach(() => {
    lua = openRadar();
  });

  it("sorts by discount, ignoring the vendor grouping", () => {
    lua.clickHeader("折扣");
    expect(lua.names()).toEqual(["Mageweave Cloth", "Gold Ore", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts by profit", () => {
    lua.clickHeader("利润");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts by reference price", () => {
    lua.clickHeader("参考价");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("sorts the item column by name, ascending first", () => {
    lua.clickHeader("物品");
    expect(lua.names()).toEqual(["Gold Ore", "Linen Cloth [NPC必赚]", "Mageweave Cloth"]);
  });

  // Money columns open cheapest-first because that is the question being
  // asked; the profit columns open biggest-first for the same reason.
  it("opens the min price column ascending and the profit column descending", () => {
    lua.clickHeader("最低价");
    expect(lua.names()).toEqual(["Linen Cloth [NPC必赚]", "Mageweave Cloth", "Gold Ore"]);
    lua.clickHeader("利润");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("reverses on a second click of the same column", () => {
    lua.clickHeader("最低价");
    lua.clickHeader("最低价");
    expect(lua.names()).toEqual(["Gold Ore", "Mageweave Cloth", "Linen Cloth [NPC必赚]"]);
  });

  it("marks the sorted column and moves the marker when another is clicked", () => {
    expect(lua.header(2)).toBe("利润");
    lua.clickHeader("利润");
    expect(lua.header(2)).toBe("利润 ▼");
    lua.clickHeader("利润");
    expect(lua.header(2)).toBe("利润 ▲");
    lua.clickHeader("折扣");
    expect(lua.header(1)).toBe("折扣 ▼");
    expect(lua.header(2)).toBe("利润");
  });

  it("drops the sort when the rows are rebuilt, because the old key no longer describes them", () => {
    lua.clickHeader("物品");
    expect(lua.names()).toEqual(["Gold Ore", "Linen Cloth [NPC必赚]", "Mageweave Cloth"]);
    lua.findDeals();
    expect(lua.header(0)).toBe("物品");
    expect(lua.names()).toEqual(BY_PROFIT);
  });
});

describe("search results table", () => {
  // Unit price is what decides a stack purchase, so it is both the default
  // sort and the place the money formatter is exercised hardest.
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

  it("switches the columns with the mode and blanks the slot it does not use", () => {
    expect([1, 2, 3, 4].map((slot) => lua.header(slot))).toEqual(["", "数量", "单价", "总价"]);
  });

  it("orders by unit price so a cheap stack cannot hide behind a small total", () => {
    expect(lua.column(2)).toEqual(["3", "1", "1", "1", "1", "1"]);
    expect(lua.column(4)).toEqual(["1银 01铜", "99铜", "1银 00铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });

  it("prints two units at every magnitude, keeping the silver that decides a bait price", () => {
    expect(lua.column(3)).toEqual(["34铜", "99铜", "1银 00铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });

  it("sorts by total price without disturbing the unit column's meaning", () => {
    lua.clickHeader("总价");
    expect(lua.column(4)).toEqual(["99铜", "1银 00铜", "1银 01铜", "99银 99铜", "1金 00银", "123金 45银"]);
  });
});

describe("locale", () => {
  it("takes column labels, money suffixes and sort markers from the locale table", () => {
    const lua = openRadar({ locale: "enUS" });
    expect([0, 1, 2, 3, 4].map((slot) => lua.header(slot))).toEqual([
      "Item",
      "Disc",
      "Profit",
      "Min",
      "Reference"
    ]);
    expect(lua.cell(1, 2)).toBe("2s 00c");
    expect(lua.cell(2, 4)).toBe("5g 20s");
    lua.clickHeader("Profit");
    expect(lua.header(2)).toBe("Profit v");
  });
});
