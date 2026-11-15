// The client's authoritative statement of a commodity fill is
// COMMODITY_PURCHASED(itemID, quantity). A market buy can fill fewer units
// than requested when the book thins out between the confirmation and the
// fill, so the ledger must book the reported quantity, not the click.
import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

const LINEN = 2589;

function page(): WowLua {
  const lua = loadAddon();
  lua.setScan([{ itemId: LINEN, name: "Linen Cloth", minPrice: 100, numAuctions: 6 }]);
  lua.setPoints([{ itemId: LINEN, closes: [90, 100, 110] }]);
  lua.openTab();
  lua.search("Linen", [{ itemId: LINEN, name: "Linen Cloth", count: 20, buyout: 2000, commodity: true }]);
  return lua;
}

// A native purchase writes only the journal. The plan must still see the
// depth it removed, otherwise "next step" keeps advertising goods the player
// already owns.
function projectionPage(): WowLua {
  const lua = loadAddon();
  lua.setScan([{
    itemId: LINEN, name: "Linen Cloth", minPrice: 100, sellP: 600,
    numAuctions: 6, sellers: 3, quantity: 20, itemClass: "Trade Goods",
    tiers: [{ p: 100, q: 20 }]
  }]);
  lua.setPoints([{ itemId: LINEN, closes: [600, 600, 600, 600, 600, 600], spacing: 1800 }]);
  lua.openTab();
  return lua;
}

describe("a native commodity buy advances the plan", () => {
  it("stops recommending the depth the purchase removed", () => {
    const lua = projectionPage();
    const steps = () => lua.value("WoWderhoiAH_Plan.steps") as Array<{
      kind: string; itemId: number; qty: number;
    }>;
    expect(steps().some((step) => step.kind === "buy" && step.itemId === LINEN)).toBe(true);

    lua.search("Linen", [{ itemId: LINEN, name: "Linen Cloth", count: 20, buyout: 2000, commodity: true }]);
    // The client puts the goods in the bag before the purchase settles.
    lua.setBag([{ bag: 0, slot: 1, itemId: LINEN, count: 20, name: "Linen Cloth" }]);
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    lua.buyRow(1);
    lua.exec(`WowTest.fireEvent('COMMODITY_PURCHASED', ${LINEN}, 20)`);
    // The purse in this fixture did not move: the only reason the buy step
    // can disappear is the projection of the booked units.
    lua.advance(3);

    const after = steps();
    expect(after.some((step) => step.kind === "buy" && step.itemId === LINEN)).toBe(false);
    expect(after.some((step) => step.kind === "sell" && step.itemId === LINEN)).toBe(true);
  });
});

describe("commodity purchase completion", () => {
  it("books the quantity the client actually filled, not the requested one", () => {
    const lua = page();
    lua.buyRow(1);
    lua.exec(`WowTest.fireEvent('COMMODITY_PURCHASED', ${LINEN}, 7)`);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(7);
    // Seven units all come from the 100c tier.
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(700);
  });

  it("books a purchase that only reports through the commodity event", () => {
    const lua = page();
    lua.buyRow(1);
    // No AUCTION_HOUSE_PURCHASE_COMPLETED at all: the commodity event alone
    // settles the purchase instead of leaving it to the timeout warning.
    lua.exec(`WowTest.fireEvent('COMMODITY_PURCHASED', ${LINEN}, 20)`);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(20);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(2000);
    expect(lua.anyChat("未确认")).toBe(false);
  });

  it("books one sale when both completion events arrive", () => {
    const lua = page();
    lua.buyRow(1);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    lua.exec("WowTest.runTimers()");
    lua.exec(`WowTest.fireEvent('COMMODITY_PURCHASED', ${LINEN}, 20)`);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(20);
  });

  it("falls back to the requested quantity when the commodity event is late", () => {
    const lua = page();
    lua.buyRow(1);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(20);
  });

  it("corrects the requested quantity when the authoritative fill arrives after the fallback", () => {
    const lua = page();
    lua.buyRow(1);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED')");
    // The 0.5s timeout books the request; the client then reports the real
    // fill. That is the same purchase, so the fact is corrected, not doubled.
    lua.exec("WowTest.advance(0.6)");
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    lua.exec(`WowTest.fireEvent('COMMODITY_PURCHASED', ${LINEN}, 7)`);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(7);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(700);
  });
});
