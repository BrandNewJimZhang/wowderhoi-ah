// "What now" is the plan's first step, not a separate cursor. A fact that
// lands (a buy, a posting, a bag change) moves the state the plan was sized
// from, so the cockpit must re-mint the plan and let the first step advance.
// These tests drive the same page a player drives: open the action tab, book
// a purchase through the journal, and read the line the page shows.
import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const SCAN = [{
  itemId: 4338,
  name: "Clean Spread",
  minPrice: 8000,
  sellP: 10000,
  numAuctions: 6,
  sellers: 3,
  quantity: 70,
  itemClass: "Trade Goods",
  tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
}];

const POINTS = [{
  itemId: 4338,
  closes: [10000, 10500, 11000, 11500, 11000, 11000],
  spacing: 1800
}];

function openPlan(): WowLua {
  const lua = loadAddon();
  lua.setScan(SCAN);
  lua.setPoints(POINTS);
  lua.openTab();
  lua.exec("WowTest.clickButton(WowTest.ns.L.NEXT_STEPS)");
  return lua;
}

function prompt(lua: WowLua): string {
  return lua.text("WowTest.plain(WoWderhoiAHTrade.next and WoWderhoiAHTrade.next:GetText() or '')");
}

describe("next step prompt", () => {
  it("names the first step and the price it may pay", () => {
    const lua = openPlan();
    const text = prompt(lua);
    expect(text).toContain("下一步");
    expect(text).toContain("买入");
    expect(text).toContain("Clean Spread");
    expect(text).toContain("单价不超过");
    expect(text).toContain("高于即放弃");
    expect(text).toContain("成交率");
  });

  it("advances after a buy is booked and the purse moves", () => {
    const lua = openPlan();
    expect(lua.names()[0]).toBe("买入 Clean Spread");
    const revision = lua.text("WoWderhoiAH_Plan.revision");
    const qty = lua.number("WoWderhoiAH_Plan.steps[1].qty");
    const cost = lua.number("WoWderhoiAH_Plan.steps[1].cost");
    expect(qty).toBeGreaterThan(0);

    // The player executes the step: the units land in the bag, the purse
    // empties, and the journal books the purchase. No new scan, no tab
    // click -- the state change alone must move the plan on.
    lua.setBag([{ bag: 0, slot: 1, itemId: 4338, count: qty, name: "Clean Spread" }]);
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    lua.exec("WowTest.setMoney(0)");
    lua.exec(`WowTest.ns.recordEvent({ k = 'buy', itemId = 4338, qty = ${qty}, cost = ${cost} })`);
    lua.advance(3);

    expect(lua.text("WoWderhoiAH_Plan.revision")).not.toBe(revision);
    expect(lua.names()[0]).toBe("卖出 Clean Spread");
    expect(prompt(lua)).toContain("挂出");
    // The plan's sell step is the base undercut, not the sell page's
    // deposit-aware price, and the line says where the price is optimized.
    expect(prompt(lua)).toContain("优化");
  });

  it("re-mints the plan without repainting a search result table", () => {
    const lua = openPlan();
    lua.exec(`
      WowTest.pendingItemResults[4338] = {
        { itemKey = C_AuctionHouse.MakeItemKey(4338, 0, 0, 0), auctionID = 7001,
          quantity = 10, itemLink = "|Hitem:4338:0:0:0|h[Clean Spread]|h",
          minBid = 90000, buyoutAmount = 90000 }
      }
      WowTest.ah.auctions[7001] = {
        itemKey = C_AuctionHouse.MakeItemKey(4338, 0, 0, 0),
        minBid = 90000, bidAmount = 90000, buyoutAmount = 90000
      }
    `);
    lua.buyRow(1); // the action's FIND click opens the result table
    expect(lua.rowCount()).toBeGreaterThan(0);
    const revision = lua.text("WoWderhoiAH_Plan.revision");
    const chat = lua.lastChat();

    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 4338, qty = 1, cost = 9000 })");
    lua.advance(2);

    // The plan moved behind the table; the table the player is reading did
    // not, and no radar announcement was printed over it.
    expect(lua.text("WoWderhoiAH_Plan.revision")).not.toBe(revision);
    expect(lua.rowCount()).toBeGreaterThan(0);
    expect(lua.lastChat()).toBe(chat);
  });
});
