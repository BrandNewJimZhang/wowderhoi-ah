// A plan identity must name every input the core read. The five original
// segments (epoch, estate, ledger, phase, character) missed the rule pack,
// the event windows and the own-sales window, so those inputs could change
// under an unchanged identity and two different predictions would share
// one name.
import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

function scanned(lua: WowLua): WowLua {
  lua.exec(`_G["WoWderhoiAH_ScanData"] = {
    server = "A", faction = "Alliance", scannedAt = time(), cash = 1000000, bagSlots = 20
  }`);
  return lua;
}

function identity(lua: WowLua): string {
  return lua.text("WowTest.ns.planRevision()");
}

describe("plan identity names every input", () => {
  it("is stable for an unchanged state", () => {
    const lua = scanned(loadAddon());
    expect(identity(lua)).toBe(identity(lua));
  });

  it("moves when the rule pack changes", () => {
    const lua = scanned(loadAddon());
    const before = identity(lua);
    lua.exec(`WowTest.ns.RULES_REVISION = "another-pack"`);
    const after = identity(lua);
    expect(after).not.toBe(before);
    expect(after).toContain(":rules:another-pack:");
  });

  it("moves when an event window opens and closes", () => {
    const lua = scanned(loadAddon());
    const now = lua.number("time()");
    const before = identity(lua);
    lua.exec(`WowTest.ns.EVENTS = { {
      name = "Window", startsAt = ${now + 3600}, endsAt = ${now + 7200}, leadHours = 0, weight = 1.5
    } }`);
    // Scheduled but not yet inside its lead window: no input changed.
    expect(identity(lua)).toBe(before);
    // Opening the window is a new input state.
    lua.advance(3600);
    const open = identity(lua);
    expect(open).not.toBe(before);
    expect(open).toContain(":events:1:");
    // Closing it is another (the end instant is inclusive).
    lua.advance(3601);
    const closed = identity(lua);
    expect(closed).not.toBe(open);
    expect(closed).toContain(":events:-:");
  });

  it("moves when a sale ages out of the own-sales window without any fact landing", () => {
    const lua = scanned(loadAddon());
    const now = lua.number("time()");
    const windowDays = lua.number("WowTest.ns.RULES.fill.ownSalesWindowDays");
    lua.exec(`WowTest.ns.recordEvent({ k = "sold", itemId = 2589, qty = 1, price = 100, fee = 5,
      t = ${now - windowDays * 86400 + 10} })`);
    const before = identity(lua);
    expect(lua.text("WowTest.ns.Ledger.ownSalesWindowKey(nil, time())")).not.toBe("-");
    // Ten seconds later the sale falls out of the window; no journal write,
    // no estate change -- only the clock moved.
    lua.advance(20);
    expect(lua.text("WowTest.ns.Ledger.ownSalesWindowKey(nil, time())")).toBe("-");
    expect(identity(lua)).not.toBe(before);
    expect(identity(lua)).toContain(":window:-");
  });

  it("moves on each existing state source", () => {
    const lua = scanned(loadAddon());
    const base = identity(lua);

    lua.exec("WoWderhoiAH_ScanData.scannedAt = WoWderhoiAH_ScanData.scannedAt + 1");
    const rescanned = identity(lua);
    expect(rescanned).not.toBe(base);

    lua.exec("WowTest.setMoney(424242)");
    lua.exec("WowTest.fireEvent('PLAYER_MONEY')");
    lua.advance(2);
    const estate = identity(lua);
    expect(estate).not.toBe(rescanned);

    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 1, cost = 100 })");
    const ledger = identity(lua);
    expect(ledger).not.toBe(estate);

    lua.exec("WowTest.ns.settings.phaseOverride = 'wave'");
    const phase = identity(lua);
    expect(phase).not.toBe(ledger);

    lua.exec("_G.UnitName = function() return 'Alt' end");
    const character = identity(lua);
    expect(character).not.toBe(phase);
    expect(character).toMatch(/:Alt:rules:/);
  });
});
