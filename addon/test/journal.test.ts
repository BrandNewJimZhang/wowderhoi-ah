// The journal is the only clean label the addon gets, and the ledger is a
// pure projection of it. These tests drive real actions through
// WAH.recordEvent and read the resulting positions, deposits and P&L.

import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function record(lua: WowLua, event: Record<string, unknown>) {
  lua.exec(`WowTest.ns.recordEvent(${toLua(event)})`);
}

describe("journal and ledger", () => {
  it("turns a buy into a position at its unit cost", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000, via: "commodity" });
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(10);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(8000);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
  });

  it("consumes lots FIFO and realizes profit against the consumed basis", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2770, qty: 10, cost: 10000 });
    record(lua, { k: "buy", itemId: 2770, qty: 10, cost: 20000 });
    record(lua, { k: "vendor", itemId: 2770, qty: 15, paid: 30000 });
    // 10 units at 1000 + 5 at 2000 = 20000 basis; 30000 - 20000 = 10000.
    expect(lua.number("WowTest.ns.Ledger.positions()[2770].qty")).toBe(5);
    expect(lua.number("WowTest.ns.Ledger.positions()[2770].cost")).toBe(10000);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(10000);
  });

  it("consumes materials when a craft is recorded", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 1000, qty: 10, cost: 10000 });
    record(lua, { k: "craft", itemId: 2000, qty: 2, cost: 10000, mats: [{ itemId: 1000, qty: 10 }] });
    expect(lua.eval("WowTest.ns.Ledger.positions()[1000]")).toBeNull();
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].qty")).toBe(2);
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].cost")).toBe(10000);
  });

  it("refunds a deposit on sale and charges the auction fee once", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, duration: 24, deposit: 500 });
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(500);
    record(lua, { k: "sold", auctionID: 7, itemId: 2589, qty: 10, price: 1200, fee: 600 });
    // 12000 - 600 - 8000 = 3400; deposit is refunded, not an expense.
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(3400);
    expect(lua.number("WowTest.ns.Ledger.capital().fees")).toBe(600);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("(WowTest.ns.Ledger.positions()[2589] and WowTest.ns.Ledger.positions()[2589].qty) or 0")).toBe(0);
  });

  it("loses the deposit on expiry and keeps the goods", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 5, cost: 5000 });
    record(lua, { k: "post", auctionID: 9, itemId: 2589, qty: 5, price: 1200, duration: 24, deposit: 300 });
    record(lua, { k: "expire", auctionID: 9 });
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(300);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(5);
  });

  it("refunds the deposit on cancellation without realizing a trade", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 5, cost: 5000 });
    record(lua, { k: "post", auctionID: 11, itemId: 2589, qty: 5, price: 1200, duration: 24, deposit: 300 });
    record(lua, { k: "cancel", auctionID: 11 });
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(0);
  });

  it("allocates disenchanting cost across the outputs", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 1000, qty: 5, cost: 5000 });
    lua.exec(
      "WowTest.ns.recordEvent({ k = 'de', itemId = 1000, qty = 5, outputs = { { itemId = 2000, qty = 2 }, { itemId = 2001, qty = 1 } } })"
    );
    expect(lua.number("(WowTest.ns.Ledger.positions()[1000] and WowTest.ns.Ledger.positions()[1000].qty) or 0")).toBe(0);
    // 5000 basis over 3 outputs = 1666.67 each, rounded at the position.
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].cost")).toBe(3333);
    expect(lua.number("WowTest.ns.Ledger.positions()[2001].cost")).toBe(1667);
  });

  it("replays idempotently: rebuilding twice yields the same ledger", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 3, itemId: 2589, qty: 4, price: 1200, duration: 24, deposit: 200 });
    record(lua, { k: "sold", auctionID: 3, itemId: 2589, qty: 4, price: 1200, fee: 240 });
    const first = lua.eval("(function() local l = WowTest.ns.Ledger.rebuild() return l.capital.realized .. '|' .. l.capital.escrow .. '|' .. l.positions[2589].qty end)()");
    const second = lua.eval("(function() local l = WowTest.ns.Ledger.rebuild() return l.capital.realized .. '|' .. l.capital.escrow .. '|' .. l.positions[2589].qty end)()");
    expect(second).toBe(first);
  });

  it("records a short position instead of inventing cost when history predates the addon", () => {
    const lua = loadAddon();
    record(lua, { k: "sold", auctionID: 1, itemId: 2589, qty: 4, price: 1200, fee: 240 });
    expect(lua.number("WoWderhoiAH_Ledger.errors[1].kind == 'short_position' and 1 or 0")).toBe(1);
    // No basis was invented: the whole revenue is realized.
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(4560);
  });

  it("rejects an unknown event kind at the write boundary", () => {
    const lua = loadAddon();
    expect(() => lua.exec("WowTest.ns.Journal.append({ k = 'teleport' })")).toThrow(/unknown event/i);
  });
});
