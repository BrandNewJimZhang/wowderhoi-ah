// fengari ships no type declarations. Declaring only the C-API entry points
// the harness and the terminal bridge actually call keeps the boundary
// typechecked without mirroring the whole Lua API.

declare module "fengari" {
  type LuaState = { readonly __lua: unique symbol };

  export function to_luastring(text: string): Uint8Array;
  export function to_jsstring(bytes: Uint8Array): string;

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadbuffer(state: LuaState, source: Uint8Array, size: number, name: Uint8Array): number;
  };

  export const lualib: {
    luaL_openlibs(state: LuaState): void;
  };

  export const lua: {
    LUA_OK: number;
    LUA_TNIL: number;
    LUA_TBOOLEAN: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
    LUA_TFUNCTION: number;
    lua_pcall(state: LuaState, args: number, results: number, handler: number): number;
    lua_pushnil(state: LuaState): void;
    lua_pushnumber(state: LuaState, value: number): void;
    lua_pushboolean(state: LuaState, value: boolean): void;
    lua_pushstring(state: LuaState, value: Uint8Array): void;
    lua_pushvalue(state: LuaState, index: number): void;
    lua_newtable(state: LuaState): void;
    lua_getglobal(state: LuaState, name: Uint8Array): number;
    lua_setglobal(state: LuaState, name: Uint8Array): void;
    lua_getfield(state: LuaState, index: number, key: Uint8Array): number;
    lua_setfield(state: LuaState, index: number, key: Uint8Array): void;
    lua_next(state: LuaState, index: number): number;
    lua_gettop(state: LuaState): number;
    lua_remove(state: LuaState, index: number): void;
    lua_pop(state: LuaState, count: number): void;
    lua_type(state: LuaState, index: number): number;
    lua_tostring(state: LuaState, index: number): Uint8Array;
    lua_tonumber(state: LuaState, index: number): number;
    lua_toboolean(state: LuaState, index: number): boolean;
  };
}
