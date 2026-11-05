// Shared Lua <-> JS value bridge for the terminal's fengari runner and for
// the addon test harness. One serializer, one table reader: a fixture must
// cross the boundary the same way in tests and in production.
import { lua, to_jsstring, type LuaState } from "fengari";

// JS value -> Lua table literal. Arrays become sequences and objects become
// tables. A numeric object key is an item id and is emitted as a Lua number,
// because the addon indexes `market.items` by number and `pairs()` must not
// hand it strings.
export function toLua(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `{${value.map(toLua).join(",")}}`;
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => {
      // Numeric object keys are itemIds: they must reach Lua as numbers,
      // because the addon indexes its tables by number and pairs() would
      // otherwise hand back strings that no arithmetic can use.
      const luaKey = /^-?\d+$/.test(key) ? key : JSON.stringify(key);
      return `[${luaKey}]=${toLua(entry)}`;
    });
  return `{${fields.join(",")}}`;
}

// Lua value at `index` -> JS. Positive indices only: a negative index
// would move as the table walk pushes values underneath it.
export function fromLua(state: LuaState, index: number): unknown {
  const type = lua.lua_type(state, index);
  if (type === lua.LUA_TNIL) return null;
  if (type === lua.LUA_TBOOLEAN) return Boolean(lua.lua_toboolean(state, index));
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(state, index);
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(state, index));
  if (type !== lua.LUA_TTABLE) return null;
  return tableToJs(state, index);
}

function tableToJs(state: LuaState, index: number): unknown {
  const entries: Array<[string | number, unknown]> = [];
  lua.lua_pushnil(state);
  while (lua.lua_next(state, index) !== 0) {
    const keyType = lua.lua_type(state, -2);
    const key = keyType === lua.LUA_TNUMBER
      ? lua.lua_tonumber(state, -2)
      : to_jsstring(lua.lua_tostring(state, -2));
    const value = fromLua(state, lua.lua_gettop(state));
    entries.push([key, value]);
    lua.lua_pop(state, 1);
  }
  // A table whose keys are exactly 1..n is an array; anything else is an
  // object. Mixed tables keep numeric keys as strings, which is the least
  // surprising shape for a JSON consumer.
  const numeric = entries.every(([key]) => typeof key === "number" && Number.isInteger(key) && key >= 1);
  const max = numeric ? Math.max(0, ...entries.map(([key]) => key as number)) : 0;
  if (numeric && max === entries.length) {
    const array: unknown[] = new Array(max);
    for (const [key, value] of entries) array[(key as number) - 1] = value;
    return array;
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of entries) record[String(key)] = value;
  return record;
}
