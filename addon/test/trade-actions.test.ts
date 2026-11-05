// The cockpit shows the core's conditional plans, not just the radar. The
// same evaluation that ranks rows also says what to do next -- including
// the sell plan for a held position -- and the game page had no surface for
// it until this mode existed.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

function cockpit(withPosition: boolean) {
  const lua = loadAddon();
  if (withPosition) {
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 4338, qty = 10, cost = 80000 })");
  }
  lua.setScan([{
    itemId: 4338,
    name: "Clean Spread",
    minPrice: 8000,
    sellP: 10000,
    numAuctions: 6,
    sellers: 3,
    quantity: 70,
    itemClass: "Trade Goods",
    tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
  }]);
  lua.setPoints([{ itemId: 4338, closes: [10000, 10500, 11000, 11500, 11000, 11000] }]);
  lua.openTab();
  lua.exec("WowTest.clickButton(WowTest.ns.L.NEXT_STEPS)");
  return lua;
}

describe("next steps mode", () => {
  it("renders the conditional buy plan with its price and net", () => {
    const lua = cockpit(false);
    expect(lua.names()).toEqual(["买入 Clean Spread"]);
    expect(lua.header(5)).toContain("成交率");
    // The plan quotes the allocated price, not a bare market depth.
    expect(lua.cell(1, 2)).not.toBe("");
    expect(lua.cell(1, 4)).not.toBe("");
  });

  it("includes the sell plan of a held position", () => {
    const lua = cockpit(true);
    const names = lua.names();
    expect(names).toContain("卖出 Clean Spread");
    expect(names).toContain("买入 Clean Spread");
  });

  it("keeps the core's urgency order when a header is clicked", () => {
    const lua = cockpit(true);
    const before = lua.names();
    lua.clickHeader("净利");
    expect(lua.names()).toEqual(before);
  });
});
