// /wahadopt is the player's explicit "I acted on this recommendation" act.
// It writes an annotation the ledger ignores and the terminal reads.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

describe("decision adoption", () => {
  it("builds the terminal's identity from the latest scan", () => {
    const lua = loadAddon();
    // Test chunks get their own environment in the harness, so a bare
    // assignment would not reach the addon globals; SavedVariables live
    // in _G in the game.
    lua.exec(`_G["WoWderhoiAH_ScanData"] = { server = "CN5 Realm 8 PvP", faction = "Alliance", scannedAt = 1794124697 }`);
    const revision = lua.text("WowTest.ns.planRevision()");
    expect(revision).toMatch(/^CN5 Realm 8 PvP\|Alliance\|1794124697:\d+:\d+$/);
    lua.exec(`SlashCmdList["WOWDERHOIAHADOPT"]("2589 buy")`);
    lua.exec(`WowTest.adoptEvent = WowTest.ns.Journal.last("adopt")`);
    expect(lua.text("WowTest.adoptEvent.id")).toBe(`${revision}:2589:buy`);
  });

  it("accepts a full id", () => {
    const lua = loadAddon();
    lua.exec(`SlashCmdList["WOWDERHOIAHADOPT"]("A|Alliance|1721700000:2589:sell")`);
    lua.exec(`WowTest.adoptEvent = WowTest.ns.Journal.last("adopt")`);
    expect(lua.text("WowTest.adoptEvent.id")).toBe("A|Alliance|1721700000:2589:sell");
  });

  it("records nothing without a scan", () => {
    const lua = loadAddon();
    lua.exec(`_G["WoWderhoiAH_ScanData"] = nil`);
    lua.exec(`SlashCmdList["WOWDERHOIAHADOPT"]("2589 buy")`);
    expect(lua.text(`tostring(WowTest.ns.Journal.last("adopt"))`)).toBe("nil");
  });

  it("does not make the ledger replay report an unknown event", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.adoptReplay = WowTest.ns.Ledger.replay({
      { t = 100, k = "buy", itemId = 2589, qty = 2, cost = 200 },
      { t = 200, k = "adopt", id = "A|Alliance|100:2589:buy" }
    }, "A")`);
    expect(lua.number("WowTest.adoptReplay.positions[2589].qty")).toBe(2);
    expect(lua.number("#WowTest.adoptReplay.errors")).toBe(0);
  });
});

describe("plan publication", () => {
  it("exports the plan identity and steps without the market rows", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.ns.publishPlan({
      revision = "A|Alliance|100:2:3",
      steps = { { kind = "buy", itemId = 2589, qty = 5 } },
      resources = { cashBefore = 1000, cashAfter = 500 },
      unplanned = { { kind = "buy", itemId = 1, reason = "cash" } }
    })`);
    expect(lua.text("WoWderhoiAH_Plan.revision")).toBe("A|Alliance|100:2:3");
    expect(lua.number("WoWderhoiAH_Plan.estateRevision")).toBe(lua.number("WowTest.ns.Estate.revision()"));
    expect(lua.number("WoWderhoiAH_Plan.ledgerRevision")).toBe(lua.number("WowTest.ns.Journal.revision()"));
    expect(lua.number("#WoWderhoiAH_Plan.steps")).toBe(1);
    expect(lua.text("WoWderhoiAH_Plan.steps[1].kind")).toBe("buy");
  });
});
