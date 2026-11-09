// The cockpit shows the core's conditional plans, not just the radar. The
// same evaluation that ranks rows also says what to do next -- including
// the sell plan for a held position -- and the game page had no surface for
// it until this mode existed.
import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

function cockpit(withPosition: boolean) {
  const lua = loadAddon();
  if (withPosition) {
    // The sell plan reads the bag snapshot, not the ledger alone: ten units
    // booked by the journal are only sellable if they are actually carried.
    lua.setBag([{ bag: 0, slot: 1, itemId: 4338, count: 10, name: "Clean Spread" }]);
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    lua.advance(2);
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 4338, qty = 10, cost = 80000 })");
    lua.exec("WowTest.ns.Reconciler.publish()");
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

// Put one auction-house result in front of the FIND click. The plan's cap
// for this book is 9999 * 0.95 - 100 = 9399 copper per unit.
function primeBook(lua: WowLua, unitPrice: number): void {
  lua.exec(`
    WowTest.pendingItemResults[4338] = {
      { itemKey = C_AuctionHouse.MakeItemKey(4338, 0, 0, 0), auctionID = 7001,
        quantity = 10, itemLink = "|Hitem:4338:0:0:0|h[Clean Spread]|h",
        minBid = ${unitPrice * 10}, buyoutAmount = ${unitPrice * 10} }
    }
    WowTest.ah.auctions[7001] = {
      itemKey = C_AuctionHouse.MakeItemKey(4338, 0, 0, 0),
      minBid = ${unitPrice * 10}, bidAmount = ${unitPrice * 10},
      buyoutAmount = ${unitPrice * 10}
    }
  `);
}

function openPlan(): WowLua {
  const lua = loadAddon();
  lua.setScan([{
    itemId: 4338, name: "Clean Spread", minPrice: 8000, sellP: 10000,
    numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
    tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
  }]);
  lua.setPoints([{ itemId: 4338, closes: [10000, 10500, 11000, 11500, 11000, 11000], spacing: 1800 }]);
  lua.openTab();
  lua.exec("WowTest.clickButton(WowTest.ns.L.NEXT_STEPS)");
  return lua;
}

describe("buy plan price cap", () => {
  it("refuses to buy a listing above the plan's abort price", () => {
    const lua = openPlan();
    primeBook(lua, 9500);
    lua.buyRow(1); // FIND: carries the plan's cap into the search
    lua.buyRow(1); // BUY on the result row
    expect(lua.anyChat("高于计划上限")).toBe(true);
    expect(lua.eval("WowTest.bid == nil")).toBe(true);
  });

  it("buys a listing inside the plan's cap", () => {
    const lua = openPlan();
    primeBook(lua, 9000);
    lua.buyRow(1);
    lua.buyRow(1);
    expect(lua.anyChat("高于计划上限")).toBe(false);
    expect(lua.number("WowTest.bid.auctionID")).toBe(7001);
  });
});

describe("scan refresh", () => {
  it("leaves a search result view alone when a scan lands", () => {
    const lua = openPlan();
    primeBook(lua, 9000);
    lua.buyRow(1); // the action's FIND click opens the result table
    expect(lua.names().length).toBeGreaterThan(0);
    // The new book is flat, so a radar refresh would announce "no
    // opportunity" over the table the player is reading.
    lua.runScan([{ itemId: 4338, name: "Clean Spread", count: 10, buyout: 8000 }]);
    lua.advance(1);
    expect(lua.anyChat("当前没有满足本阶段门槛的可执行机会")).toBe(false);
    expect(lua.names().length).toBeGreaterThan(0);
  });

  it("rebuilds the visible radar when a scan lands", () => {
    const lua = loadAddon();
    lua.setScan([{
      itemId: 4338, name: "Clean Spread", minPrice: 8000, sellP: 10000,
      numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
    }]);
    lua.setPoints([{ itemId: 4338, closes: [10000, 10500, 11000, 11500, 11000, 11000], spacing: 1800 }]);
    lua.openTab();
    lua.findDeals();
    expect(lua.names()).toEqual(["Clean Spread"]);
    // The new book has one flat tier: no executable spread.
    lua.runScan([{ itemId: 4338, name: "Clean Spread", count: 10, buyout: 8000 }]);
    // The refresh is scheduled after the save, not inside the finish frame.
    lua.advance(1);
    expect(lua.names()).toEqual([]);
  });
});

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
