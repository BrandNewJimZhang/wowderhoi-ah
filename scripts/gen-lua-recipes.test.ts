// The compiled recipe table ships inside the addon; it must be regenerated,
// never edited. A drift here would price crafts against stale materials.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateLuaRecipes } from "./gen-lua-recipes";

const LUA_PATH = fileURLToPath(new URL("../addon/WoWderhoiAH/GeneratedRecipes.lua", import.meta.url));

describe("compiled recipes", () => {
  it("matches the committed GeneratedRecipes.lua", () => {
    expect(readFileSync(LUA_PATH, "utf8")).toBe(generateLuaRecipes());
  });

  it("stays inside the login budget", () => {
    const source = generateLuaRecipes();
    expect(source.length).toBeLessThan(250 * 1024);
  });
});
