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
