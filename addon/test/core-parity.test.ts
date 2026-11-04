// The terminal does not reimplement the radar: src/lib/core/run-core.ts
// loads the same Core.lua the addon ships. This test proves the two load
// paths agree, byte for byte on the values that decide a trade.
import { describe, expect, it } from "vitest";
import { runCore } from "@/lib/core/run-core";
import { commodityInput } from "@/lib/core/fixtures";
import { loadAddon } from "./wow-lua";

describe("decision core parity", () => {
  it("addon harness and terminal runner return the same evaluation", () => {
    const input = commodityInput();
    input.positions = { 2589: { qty: 40, cost: 32000 } };
    const fromAddon = loadAddon().coreEval(input);
    const fromTerminal = runCore(input);
    expect(fromAddon).toEqual(fromTerminal);
  });

  it("agrees on an empty book and on a rejected spread", () => {
    const empty = commodityInput();
    empty.market.items = {};
    expect(loadAddon().coreEval(empty)).toEqual(runCore(empty));

    const rejected = commodityInput();
    rejected.market.items[2589].minPrice = 50;
    expect(loadAddon().coreEval(rejected)).toEqual(runCore(rejected));
  });

  it("exposes the sell plan arithmetic through the same core", () => {
    const lua = loadAddon();
    const plan = lua.eval(
      "(function() local p = WowTest.ns.Core.sellPlan({ itemId = 2589, sellP = 1000, vendorP = 10 }, { qty = 10, cost = 8000 }, WowTest.ns.RULES, { deposit = 500 }) return p.netIfSold .. '|' .. p.sellBreakeven .. '|' .. p.expireBreakeven .. '|' .. p.lossIfExpired end)()"
    );
    expect(plan).toBe("1491|842|895|8500");
  });
});
