// Capacity and phase anchors are inputs to the same decision core. A
// hardcoded bag size or a local first-scan anchor silently changes what the
// radar recommends, so both are read from the client or the settings.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

function scanned(lua: ReturnType<typeof loadAddon>) {
  // Breadth 100 clears the ignition width gate, so the phase is decided by
  // data age alone -- which is exactly what the opening anchor changes.
  lua.setScan(Array.from({ length: 100 }, (_, index) => ({
    itemId: 2589 + index,
    name: `item-${index}`,
    minPrice: 700,
    sellP: 1000,
    quantity: 100,
    numAuctions: 5
  })));
}

describe("capacity inputs", () => {
  it("reads free bag slots from the client", () => {
    const lua = loadAddon();
    lua.exec("WowTest.freeBagSlots = { [0] = 2, [1] = 3, [2] = 1 }");
    expect(lua.number("WowTest.ns.coreInput().capacity.bagSlots")).toBe(6);
  });

  it("counts zero free slots as zero, not as the planning default", () => {
    const lua = loadAddon();
    lua.exec("WowTest.freeBagSlots = {}");
    expect(lua.number("WowTest.ns.coreInput().capacity.bagSlots")).toBe(0);
  });

  it("hands the core the purse before the daily share", () => {
    const lua = loadAddon();
    scanned(lua);
    // The core applies portfolio.dailyBudget once, during allocation.
    // Discounting it here would give the in-game radar half the spend the
    // terminal grants for the same cash.
    const input = lua.eval(
      "(function() local i = WowTest.ns.coreInput() return i.capital.cash .. '|' .. i.capital.budget end)()"
    );
    expect(input).toBe("1000000|1000000");
  });
});

describe("server opening anchor", () => {
  it("advances the phase from the configured opening time", () => {
    const lua = loadAddon();
    scanned(lua);
    // The stub series starts an hour ago: ignition by data age.
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("ignition");
    lua.exec("WowTest.ns.settings.serverOpenedAt = " + (1_700_000_000 - 10 * 3600));
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("wave");
  });

  it("clears the anchor back to the first scan", () => {
    const lua = loadAddon();
    scanned(lua);
    lua.exec("WowTest.ns.settings.serverOpenedAt = " + (1_700_000_000 - 10 * 3600));
    lua.exec("SlashCmdList['WOWDERHOIAHOPEN']('auto')");
    expect(lua.number("WowTest.ns.settings.serverOpenedAt")).toBe(0);
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("ignition");
  });

  it("accepts 'now' and relative hours", () => {
    const lua = loadAddon();
    lua.exec("SlashCmdList['WOWDERHOIAHOPEN']('now')");
    expect(lua.number("WowTest.ns.settings.serverOpenedAt")).toBe(1_700_000_000);
    lua.exec("SlashCmdList['WOWDERHOIAHOPEN']('-6')");
    expect(lua.number("WowTest.ns.settings.serverOpenedAt")).toBe(1_700_000_000 - 6 * 3600);
  });
});
