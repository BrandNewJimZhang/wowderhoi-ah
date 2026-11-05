// Craft capture turns a finished craft into a journal event whose cost is
// the ledger's own FIFO basis for the consumed materials. These tests drive
// the real client events, including the recipe-id and product fallbacks.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function record(lua: WowLua, event: Record<string, unknown>) {
  lua.exec(`WowTest.ns.recordEvent(${toLua(event)})`);
}

function craft(lua: WowLua, recipeSpellId: number, result: Record<string, unknown>) {
  lua.exec(`WowTest.fireEvent("TRADE_SKILL_CRAFT_BEGIN", ${recipeSpellId})`);
  lua.exec(`WowTest.fireEvent("TRADE_SKILL_ITEM_CRAFTED_RESULT", ${toLua(result)})`);
}

describe("craft capture", () => {
  it("books the product at the material FIFO cost", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2318, qty: 10, cost: 1000 });
    record(lua, { k: "buy", itemId: 2320, qty: 10, cost: 500 });
    craft(lua, 1353, { itemID: 2302, quantity: 1 });
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(3);
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].qty")).toBe(1);
    // 2 x 100 + 1 x 50 = 250, the consumed lots' book value.
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].cost")).toBe(250);
    expect(lua.number("WowTest.ns.Ledger.positions()[2318].qty")).toBe(8);
  });

  it("divides the material cost across a multicraft result", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2318, qty: 10, cost: 1000 });
    record(lua, { k: "buy", itemId: 2320, qty: 10, cost: 500 });
    craft(lua, 1353, { itemID: 2302, quantity: 3, multicraft: 2 });
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].qty")).toBe(3);
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].cost")).toBe(250);
  });

  it("resolves a recipe spell id through the client's recipe id", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2318, qty: 10, cost: 1000 });
    record(lua, { k: "buy", itemId: 2320, qty: 10, cost: 500 });
    lua.exec("WowTest.recipeInfo[9001] = { recipeID = 1353 }");
    craft(lua, 9001, { itemID: 2302, quantity: 1 });
    // The spell id is not in the dataset; GetRecipeInfo names recipe 1353,
    // whose materials price the product.
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].cost")).toBe(250);
  });

  it("falls back to the unique product index when only the result is known", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2318, qty: 10, cost: 1000 });
    record(lua, { k: "buy", itemId: 2320, qty: 10, cost: 500 });
    craft(lua, 777777, { itemID: 2302, quantity: 1 });
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].cost")).toBe(250);
  });

  it("counts an unknown recipe as unmapped instead of booking a wrong cost", () => {
    const lua = loadAddon();
    craft(lua, 777777, { itemID: 999999, quantity: 1 });
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(0);
    expect(lua.number("WowTest.ns.Craft.unmapped")).toBe(1);
  });

  it("records a short position when the materials were never booked", () => {
    const lua = loadAddon();
    craft(lua, 1353, { itemID: 2302, quantity: 1 });
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].qty")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2302].cost")).toBe(0);
    expect(lua.number("WoWderhoiAH_Ledger.errors[1].kind == 'short_position' and 1 or 0")).toBe(1);
  });
});
