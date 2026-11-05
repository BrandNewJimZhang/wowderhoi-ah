// Cross-character moves and manual capture paths. The ledger has to carry
// cost basis across a transfer, and paths the client does not report get an
// explicit command instead of a guessed event.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

describe("transfers", () => {
  it("moves quantity and basis out of the sending book", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.ns.transferResult = WowTest.ns.Ledger.replay({
      { t = 100, k = "buy", itemId = 2589, qty = 10, cost = 1000 },
      { t = 200, k = "transfer_out", itemId = 2589, qty = 4, cost = 400 }
    }, "A")`);
    expect(lua.number("WowTest.ns.transferResult.positions[2589].qty")).toBe(6);
    expect(lua.number("WowTest.ns.transferResult.positions[2589].cost")).toBe(600);
  });

  it("adds the received lot at the cost the sender recorded", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.ns.transferResult = WowTest.ns.Ledger.replay({
      { t = 100, k = "transfer_in", itemId = 2589, qty = 4, cost = 400 }
    }, "B")`);
    expect(lua.number("WowTest.ns.transferResult.positions[2589].qty")).toBe(4);
    expect(lua.number("WowTest.ns.transferResult.positions[2589].cost")).toBe(400);
  });

  it("records the sending command with the ledger's average cost", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 10, cost = 1000 })");
    lua.exec(`SlashCmdList["WOWDERHOIAHTRANSFER"]("2589 4 out")`);
    lua.exec("WowTest.transferEvent = WowTest.ns.Journal.last('transfer_out')");
    expect(lua.number("WowTest.transferEvent.qty")).toBe(4);
    expect(lua.number("WowTest.transferEvent.cost")).toBe(400);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(6);
  });

  it("records a received lot from the manual cost", () => {
    const lua = loadAddon();
    lua.exec(`SlashCmdList["WOWDERHOIAHTRANSFER"]("2589 2 in 150")`);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(300);
  });
});

describe("manual vendor capture", () => {
  it("books a vendor sale as realized cash at the paid price", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 10, cost = 1000 })");
    lua.exec(`SlashCmdList["WOWDERHOIAHCOST"]("2589 10 500")`);
    lua.exec("WowTest.vendorEvent = WowTest.ns.Journal.last('vendor')");
    expect(lua.number("WowTest.vendorEvent.qty")).toBe(10);
    expect(lua.number("WowTest.vendorEvent.paid")).toBe(500);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(-500);
  });
});
