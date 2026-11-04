// Runs the shipped addon Lua inside fengari so the display logic that has
// no other reachable surface -- column slots, header clicks, money
// formatting, sort order -- can be driven the way a player drives it.
//
// The addon files are loaded verbatim from addon/WoWderhoiAH in the order
// the .toc declares, so the load order under test is the load order that
// ships; there is no second list to keep in sync.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { fromLua, toLua } from "@/lib/core/lua-bridge";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADDON_DIR = path.join(TEST_DIR, "..", "WoWderhoiAH");
const ADDON_NAME = "WoWderhoiAH";

function tocFiles() {
  const toc = fs.readFileSync(path.join(ADDON_DIR, `${ADDON_NAME}.toc`), "utf8");
  return toc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith(".lua"));
}

export { toLua };

export type WowLua = ReturnType<typeof loadAddon>;

export function loadAddon(options?: { locale?: string }) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);

  function fail(context: string): never {
    const message = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    throw new Error(`${context}: ${message}`);
  }

  function load(source: string, chunkName: string) {
    const buffer = to_luastring(source);
    if (lauxlib.luaL_loadbuffer(state, buffer, buffer.length, to_luastring(`@${chunkName}`)) !== lua.LUA_OK) {
      fail(`syntax error in ${chunkName}`);
    }
  }

  function exec(source: string) {
    load(source, "test");
    if (lua.lua_pcall(state, 0, 0, 0) !== lua.LUA_OK) fail("lua error");
  }

  load(fs.readFileSync(path.join(TEST_DIR, "wow-stub.lua"), "utf8"), "wow-stub.lua");
  if (lua.lua_pcall(state, 0, 0, 0) !== lua.LUA_OK) fail("stub failed to load");
  if (options?.locale) exec(`WowTest.locale = ${toLua(options.locale)}`);

  // Each file gets the two varargs the client passes: the addon name and
  // the shared namespace table every file writes into.
  for (const file of tocFiles()) {
    load(fs.readFileSync(path.join(ADDON_DIR, file), "utf8"), file);
    lua.lua_pushstring(state, to_luastring(ADDON_NAME));
    lua.lua_getglobal(state, to_luastring("WowTest"));
    lua.lua_getfield(state, -1, to_luastring("ns"));
    lua.lua_remove(state, -2);
    if (lua.lua_pcall(state, 2, 0, 0) !== lua.LUA_OK) fail(`${file} failed to load`);
  }
  // ADDON_LOADED carries the addon name, and Settings.lua ignores the event
  // without it -- which would leave WAH.settings nil and every setting-gated
  // branch running on the nil fallback instead of the shipped defaults.
  exec(`WowTest.fireEvent('ADDON_LOADED', ${toLua(ADDON_NAME)})`);

  function evaluate(expression: string): string | number | boolean | null {
    load(`return ${expression}`, "test");
    if (lua.lua_pcall(state, 0, 1, 0) !== lua.LUA_OK) fail("lua error");
    const kind = lua.lua_type(state, -1);
    let result: string | number | boolean | null = null;
    if (kind === lua.LUA_TSTRING) result = to_jsstring(lua.lua_tostring(state, -1));
    else if (kind === lua.LUA_TNUMBER) result = lua.lua_tonumber(state, -1);
    else if (kind === lua.LUA_TBOOLEAN) result = Boolean(lua.lua_toboolean(state, -1));
    lua.lua_pop(state, 1);
    return result;
  }

  return {
    exec,
    eval: evaluate,
    text: (expression: string) => String(evaluate(expression)),
    number: (expression: string) => Number(evaluate(expression)),

    // Run the shipped decision core inside the addon harness and read the
    // result back as JS. The terminal runs the same file through fengari in
    // src/lib/core/run-core.ts; a parity test compares the two.
    coreEval: (input: unknown): unknown => {
      exec(`WowTest.coreResult = WowTest.ns.Core.evaluate(${toLua(input)})`);
      lua.lua_getglobal(state, to_luastring("WowTest"));
      lua.lua_getfield(state, -1, to_luastring("coreResult"));
      const result = fromLua(state, lua.lua_gettop(state));
      lua.lua_pop(state, 2);
      return result;
    },
    setScan: (items: unknown[]) => exec(`WowTest.setScan(${toLua(items)})`),
    setPoints: (entries: unknown[]) => exec(`WowTest.setPoints(${toLua(entries)})`),
    runScan: (items: unknown[]) => exec(`WowTest.runScan(${toLua(items)})`),
    openTab: () => exec("WowTest.openTab()"),
    findDeals: () => exec("WowTest.clickButton(WowTest.ns.L.FIND_DEALS)"),
    search: (query: string, listings: unknown[]) =>
      exec(`WowTest.search(${toLua(query)}, ${toLua(listings)})`),
    clickHeader: (label: string) => exec(`WowTest.clickHeader(${toLua(label)})`),

    rowCount: () => Number(evaluate("WowTest.rowCount()")),
    rowName: (row: number) => String(evaluate(`WowTest.rowName(${row})`)),
    cell: (row: number, slot: number) => String(evaluate(`WowTest.cellText(${row}, ${slot})`)),
    header: (slot: number) => String(evaluate(`WowTest.headerText(${slot})`)),
    names: () => {
      const count = Number(evaluate("WowTest.rowCount()"));
      return Array.from({ length: count }, (_, index) => String(evaluate(`WowTest.rowName(${index + 1})`)));
    },
    column: (slot: number) => {
      const count = Number(evaluate("WowTest.rowCount()"));
      return Array.from({ length: count }, (_, index) => String(evaluate(`WowTest.cellText(${index + 1}, ${slot})`)));
    },
    lastChat: () => String(evaluate("WowTest.lastChat()")),
    anyChat: (text: string) => Boolean(evaluate(`WowTest.anyChat(${toLua(text)})`)),

    panelHeight: () => Number(evaluate("WowTest.panelHeight()")),
    clearance: (side: "LEFT" | "RIGHT" | "TOP" | "BOTTOM") =>
      Number(evaluate(`WowTest.panelClearance(${toLua(side)})`)),
    backdropInset: (side: "left" | "right" | "top" | "bottom") =>
      Number(evaluate(`WowTest.backdropInset(${toLua(side)})`)),
    visibleRows: () => Number(evaluate("WowTest.visibleRows()")),
    wrappingCells: () => Number(evaluate("WowTest.wrappingCells()")),

    hoverRow: (row: number) => exec(`WowTest.hoverRow(${row})`),
    leaveRow: (row: number) => exec(`WowTest.hoverRow(${row}, true)`),
    tooltipSource: () => String(evaluate("WowTest.tooltipSource()")),
    tooltipText: () => String(evaluate("WowTest.tooltipText()")),
    tooltipShown: () => Boolean(evaluate("WowTest.tooltipShown()")),

    buyRow: (row: number) => exec(`WowTest.buyRow(${row})`),
    repriceListing: (index: number, buyout: number) =>
      exec(`WowTest.repriceListing(${index}, ${buyout})`),
    scanned: (itemId: number) => Boolean(evaluate(`WowTest.scanned(${itemId})`)),
    scanMin: (itemId: number) => evaluate(`WowTest.scanMin(${itemId})`),
    scanAuctions: (itemId: number) => evaluate(`WowTest.scanAuctions(${itemId})`)
  };
}
