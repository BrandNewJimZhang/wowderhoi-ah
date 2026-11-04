// Runs the shipped decision core (addon/WoWderhoiAH/Core.lua) inside
// fengari. The terminal does not reimplement the radar, the sell front or
// the fill probability in TypeScript: it loads the same Lua the game runs,
// so an in-game recommendation and a terminal recommendation cannot drift.
import fs from "node:fs";
import path from "node:path";
import { lauxlib, lua, lualib, to_luastring, to_jsstring, type LuaState } from "fengari";
import { fromLua, toLua } from "@/lib/core/lua-bridge";
import type { CoreInput, CoreOutput } from "@/lib/core/types";

const ADDON_NAME = "WoWderhoiAH";
const ADDON_DIR = path.join(process.cwd(), "addon", "WoWderhoiAH");
const NS_GLOBAL = "__WAH_NS";

let cachedState: LuaState | null = null;

function popError(state: LuaState, context: string): never {
  const message = to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_pop(state, 1);
  throw new Error(`${context}: ${message}`);
}

function loadChunk(state: LuaState, source: string, name: string) {
  const buffer = to_luastring(source);
  if (lauxlib.luaL_loadbuffer(state, buffer, buffer.length, to_luastring(`@${name}`)) !== lua.LUA_OK) {
    popError(state, `syntax error in ${name}`);
  }
}

// The addon files receive the addon name and the shared namespace as
// varargs. An isolated Lua state keeps the alias global harmless.
function loadAddonFile(state: LuaState, file: string) {
  loadChunk(state, fs.readFileSync(path.join(ADDON_DIR, file), "utf8"), file);
  lua.lua_pushstring(state, to_luastring(ADDON_NAME));
  lua.lua_getglobal(state, to_luastring(NS_GLOBAL));
  if (lua.lua_pcall(state, 2, 0, 0) !== lua.LUA_OK) popError(state, `${file} failed to load`);
}

function state(): LuaState {
  if (cachedState) return cachedState;
  const fresh = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(fresh);
  lua.lua_newtable(fresh);
  lua.lua_pushvalue(fresh, -1);
  lua.lua_setglobal(fresh, to_luastring(NS_GLOBAL));
  lua.lua_pop(fresh, 1);
  loadAddonFile(fresh, "GeneratedRules.lua");
  loadAddonFile(fresh, "Core.lua");
  cachedState = fresh;
  return fresh;
}

function pushInput(state: LuaState, input: CoreInput) {
  loadChunk(state, `return ${toLua(input)}`, "core-input");
  if (lua.lua_pcall(state, 0, 1, 0) !== lua.LUA_OK) popError(state, "core input failed to build");
}

function pushCoreFunction(state: LuaState) {
  lua.lua_getglobal(state, to_luastring(NS_GLOBAL));
  lua.lua_getfield(state, -1, to_luastring("Core"));
  lua.lua_getfield(state, -1, to_luastring("evaluate"));
  lua.lua_remove(state, -2); // the Core table
  lua.lua_remove(state, -2); // the namespace
}

export function runCore(input: CoreInput): CoreOutput {
  const vm = state();
  const top = lua.lua_gettop(vm);
  // The C API expects the callee below its arguments: push the function,
  // then the input table.
  pushCoreFunction(vm);
  pushInput(vm, input);
  if (lua.lua_pcall(vm, 1, 1, 0) !== lua.LUA_OK) popError(vm, "Core.evaluate failed");
  const result = fromLua(vm, lua.lua_gettop(vm)) as CoreOutput;
  lua.lua_pop(vm, 1);
  if (lua.lua_gettop(vm) !== top) {
    throw new Error(`Core.evaluate leaked Lua stack values: ${lua.lua_gettop(vm) - top}`);
  }
  return result;
}
