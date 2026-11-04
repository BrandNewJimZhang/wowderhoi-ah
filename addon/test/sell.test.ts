// The sell page is where the loop closes: it prices bag goods against the
// sell front, charges the client's deposit, posts through PostItem /
// PostCommodity, and writes the resulting facts into the journal. These
// tests drive the real Lua and assert on the ledger, not on the pixels.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const LINEN = 2589;
const MAGEWEAVE = 4338;

function page(options?: { commodity?: boolean; sellP?: number; vendorP?: number }) {
  const lua = loadAddon();
  lua.setScan([{
    itemId: LINEN,
    name: "Linen Cloth",
    minPrice: 800,
    sellP: options?.sellP ?? 1000,
    vendorP: options?.vendorP ?? 10,
    numAuctions: 5,
    sellers: 3,
    quantity: 100,
    itemClass: "Trade Goods",
    tiers: [{ p: 800, q: 20 }, { p: 900, q: 80 }]
  }, {
    itemId: MAGEWEAVE,
    name: "Mageweave Cloth",
    minPrice: 8000,
    sellP: 10000,
    vendorP: 10,
    numAuctions: 4,
    sellers: 2,
    quantity: 10,
    itemClass: "Trade Goods",
    tiers: [{ p: 8000, q: 10 }]
  }]);
  lua.setBag([{
    bag: 0, slot: 1, itemId: LINEN, count: 10, name: "Linen Cloth",
    commodity: options?.commodity ?? true
  }, {
    bag: 0, slot: 2, itemId: MAGEWEAVE, count: 10, name: "Mageweave Cloth",
    commodity: false
  }]);
  lua.exec(
    "WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 10, cost = 8000 })"
  );
  lua.exec("WowTest.ns.Sell.collectBag()");
  return lua;
}

describe("sell pricing", () => {
  it("charges the client deposit and prices against the sell front", () => {
    const lua = page();
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).deposit")).toBe(720);
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).listP")).toBe(999);
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).netIfSold")).toBe(1491);
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).sellBreakeven")).toBe(842);
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).expireBreakeven")).toBe(918);
    // Deposit 720 + (cost 8000 − NPC residual 100); the goods come back.
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).lossIfExpired")).toBe(8620);
    expect(lua.number("(WowTest.ns.Sell.plan(2589, 24, 10)).feeIfSold")).toBe(500);
  });

  it("uses the item-auction deposit formula for non-commodities", () => {
    const lua = page();
    // Item auction deposit in the stub: quantity * duration * 2.
    expect(lua.number("(WowTest.ns.Sell.plan(4338, 12, 1)).deposit")).toBe(24);
  });

  it("refuses to price an item the scan has never seen", () => {
    const lua = page();
    expect(lua.eval("WowTest.ns.Sell.plan(99999, 24, 1)")).toBeNull();
  });
});

describe("posting", () => {
  it("records a post event when the client creates the auction", () => {
    const lua = page();
    lua.exec("WowTest.ns.Sell.select(2589)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(2); // buy + post
    expect(lua.eval("WowTest.ns.Journal.last('post').auctionID")).toBe(5001);
    expect(lua.number("WowTest.ns.Journal.last('post').deposit")).toBe(720);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(720);
    expect(lua.anyChat("已上架")).toBe(true);
  });

  it("falls back to manual listing when the client blocks the call", () => {
    const lua = page();
    lua.exec("C_AuctionHouse.PostCommodity = function() error('blocked by taint') end");
    lua.exec("WowTest.ns.Sell.select(2589)");
    const ok = lua.eval("WowTest.ns.Sell.postSelected()");
    expect(ok).toBe(false);
    expect(lua.lastChat()).toContain("拦截");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1); // the buy only
  });

  it("refuses to post an item with no scan price", () => {
    const lua = page();
    lua.setBag([{ bag: 0, slot: 1, itemId: 99999, count: 1, name: "Unknown", commodity: true }]);
    lua.exec("WowTest.ns.Sell.collectBag()");
    lua.exec("WowTest.ns.Sell.select(99999)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    expect(lua.lastChat()).toContain("没有扫描价格");
  });
});

describe("owned auctions", () => {
  it("cancels an auction, refunds the deposit and records the cancel", () => {
    const lua = page();
    lua.exec("WowTest.ns.Sell.select(2589)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    expect(lua.eval("WowTest.ns.Sell.cancel(5001)")).toBe(true);
    expect(lua.number("WowTest.ns.Journal.last('cancel').refund")).toBe(710);
    expect(lua.number("WowTest.ns.Journal.last('cancel').lostDeposit")).toBe(10);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(10);
  });

  it("books an expiry as a lost deposit without consuming the goods", () => {
    const lua = page();
    lua.exec("WowTest.ns.Sell.select(2589)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTIONS_EXPIRED', 5001)");
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(720);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(10);
  });

  it("infers a sale when an owned auction vanishes before expiry", () => {
    const lua = page();
    lua.exec("WowTest.ns.Sell.select(2589)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    lua.advance(61);
    lua.setOwned([]); // the listing is gone from the owned list
    lua.exec("WowTest.fireEvent('OWNED_AUCTIONS_UPDATED')");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(3); // buy + post + sold
    const sold = "WowTest.ns.Journal.last('sold')";
    expect(lua.number(`${sold}.price`)).toBe(999);
    expect(lua.number(`${sold}.fee`)).toBe(500);
    expect(lua.eval(`${sold}.inferred`)).toBe(true);
    // 9990 - 500 - 8000 = 1490
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(1490);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
  });

  it("flags an owned listing priced above the current sell front", () => {
    const lua = page();
    lua.setOwned([{ auctionID: 9001, itemId: 2589, quantity: 10, buyoutAmount: 12000, timeLeftSeconds: 3600 }]);
    lua.exec("WowTest.ns.Sell.collectOwned()");
    expect(lua.eval("WowTest.ns.Sell.state().owned[1].undercut")).toBe(true);
  });

  it("does not reconcile a posting younger than a minute", () => {
    const lua = page();
    lua.exec("WowTest.ns.Sell.select(2589)");
    lua.exec("WowTest.ns.Sell.postSelected()");
    lua.setOwned([]);
    lua.exec("WowTest.fireEvent('OWNED_AUCTIONS_UPDATED')");
    // Same clock, so the post is too fresh to call sold.
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(2);
  });
});
