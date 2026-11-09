// Reconciliation is the place where "the ledger booked it" meets "the
// client shows it". The three quantities must stay distinct: known cost,
// unbooked stock and missing stock, and an unobserved location is not zero.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

const LINEN = 2589;

function item(lua: ReturnType<typeof loadAddon>, field: string) {
  return lua.number(`(WowTest.ns.Reconciler.item(${LINEN}) or {}).${field} or 0`);
}

function bag(lua: ReturnType<typeof loadAddon>, bagIndex: number, count: number) {
  lua.setBag([{ bag: bagIndex, slot: 1, itemId: LINEN, count, name: "Linen" }]);
  lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
  lua.exec("WowTest.advance(2)");
}

describe("reconciliation", () => {
  it("separates known cost from unbooked stock", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 5, cost = 5000 })");
    bag(lua, 0, 8);
    expect(item(lua, "ledgerQty")).toBe(5);
    expect(item(lua, "knownQty")).toBe(5);
    expect(item(lua, "unknownQty")).toBe(3);
    expect(item(lua, "missingQty")).toBe(0);
    expect(item(lua, "sellableQty")).toBe(8);
  });

  it("does not call stock missing while the bank is unobserved", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 8, cost = 8000 })");
    bag(lua, 0, 5);
    expect(item(lua, "missingQty")).toBe(0);
    expect(item(lua, "missingUnobserved")).toBe(1);
    expect(lua.text("WowTest.ns.Reconciler.current().coverage.bank")).toBe("unobserved");

    // The bank opens with the other three units.
    lua.setBag([
      { bag: 0, slot: 1, itemId: LINEN, count: 5, name: "Linen" },
      { bag: 6, slot: 1, itemId: LINEN, count: 3, name: "Linen" }
    ]);
    lua.exec("WowTest.fireEvent('BANKFRAME_OPENED')");
    lua.exec("WowTest.advance(2)");
    expect(item(lua, "bankQty")).toBe(3);
    expect(item(lua, "missingQty")).toBe(0);
    expect(item(lua, "totalQty")).toBe(8);
  });

  it("reports missing stock once every location is observed", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 8, cost = 8000 })");
    bag(lua, 0, 5);
    // Missing stock is only declarable once every location that could hold
    // the units has been observed.
    lua.exec("WowTest.fireEvent('MAIL_INBOX_UPDATE')");
    lua.setOwned([]);
    lua.exec("WowTest.fireEvent('OWNED_AUCTIONS_UPDATED')");
    // A bank frame with no account bank containers is not a read account
    // bank; seed a readable tab so every location is observed.
    lua.setBag([
      { bag: 0, slot: 1, itemId: LINEN, count: 5, name: "Linen" },
      { bag: 15, slot: 1, itemId: 4338, count: 1, name: "Mageweave" }
    ]);
    lua.exec("WowTest.fireEvent('BANKFRAME_OPENED')");
    lua.exec("WowTest.advance(2)");
    expect(item(lua, "bankQty")).toBe(0);
    expect(item(lua, "missingQty")).toBe(3);
  });

  it("counts own postings as owned but not sellable", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 4, cost = 4000 })");
    lua.exec("WowTest.ns.recordEvent({ k = 'post', auctionID = 7, itemId = 2589, qty = 4, price = 1000, deposit = 100 })");
    lua.setOwned([{ auctionID: 7, itemId: LINEN, quantity: 4, buyoutAmount: 4000 }]);
    lua.exec("WowTest.fireEvent('OWNED_AUCTIONS_UPDATED')");
    lua.exec("WowTest.advance(2)");
    expect(item(lua, "listedQty")).toBe(4);
    expect(item(lua, "sellableQty")).toBe(0);
    expect(item(lua, "missingQty")).toBe(0);
  });

  it("offers bank-only stock as a sale that requires a bank trip", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 3, cost = 3000 })");
    lua.setBag([{ bag: 6, slot: 1, itemId: LINEN, count: 3, name: "Linen" }]);
    lua.exec("WowTest.fireEvent('BANKFRAME_OPENED')");
    lua.exec("WowTest.advance(2)");
    // The bag holds none, so the plan may only sell these after a bank trip.
    expect(item(lua, "sellableQty")).toBe(3);
    expect(item(lua, "requiresBank")).toBe(1);
  });

  it("reconciles cash against the anchor and the provable delta", () => {
    const lua = loadAddon({ prelude: "WowTest.setMoney(10000)" });
    lua.exec("WowTest.setMoney(9000)");
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 1, cost = 1000 })");
    expect(lua.number("WowTest.ns.Reconciler.current().cash.anchor")).toBe(10000);
    expect(lua.number("WowTest.ns.Reconciler.current().cash.expected")).toBe(9000);
    expect(lua.number("WowTest.ns.Reconciler.current().cash.unexplained")).toBe(0);
  });

  it("leaves cash unobserved when the book has no anchor", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.Journal.book().cashAnchor = nil");
    lua.exec("WowTest.ns.Reconciler.publish()");
    expect(lua.text("WowTest.ns.Reconciler.current().cash.coverage")).toBe("unobserved");
  });
});
