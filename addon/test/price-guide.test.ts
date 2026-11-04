// The modern client exposes no sell-item query, so the old sell prefill has
// no surface to write into. /wahprice is its replacement: hold an item on
// the cursor (or pass a link) and read the same numbers.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const MAGEWEAVE = 4338;

function page(): WowLua {
  const lua = loadAddon();
  lua.setScan([{
    itemId: MAGEWEAVE, name: "Mageweave Cloth",
    minPrice: 8000, sellP: 8400, marketPrice: 9000, numAuctions: 6, quantity: 40
  }]);
  lua.setPoints([{ itemId: MAGEWEAVE, closes: [10000, 11000, 12000] }]);
  return lua;
}

describe("/wahprice", () => {
  it("prints the sell front, ladder and history for the cursor item", () => {
    const lua = page();
    lua.exec("WowTest.cursorInfo = { 'item', 4338 }");
    lua.exec("SlashCmdList['WOWDERHOIAHPRICE']('')");
    expect(lua.anyChat("7日P10中位")).toBe(true);
    expect(lua.anyChat("建议卖价")).toBe(true);
    expect(lua.anyChat("最低价")).toBe(true);
    expect(lua.anyChat("在售 40 件 / 6 笔拍卖")).toBe(true);
  });

  it("accepts an item link as the argument", () => {
    const lua = page();
    lua.exec("SlashCmdList['WOWDERHOIAHPRICE']('|Hitem:4338:0:0:0|h[Mageweave Cloth]|h')");
    expect(lua.anyChat("7日P10中位")).toBe(true);
  });

  it("tells the player how to use it when no item is available", () => {
    const lua = page();
    lua.exec("SlashCmdList['WOWDERHOIAHPRICE']('')");
    expect(lua.lastChat()).toContain("/wahprice");
  });

  it("says there is no data instead of printing a zero price", () => {
    const lua = page();
    lua.exec("WowTest.cursorInfo = { 'item', 999999 }");
    lua.exec("SlashCmdList['WOWDERHOIAHPRICE']('')");
    expect(lua.lastChat()).toContain("没有价格数据");
  });
});
