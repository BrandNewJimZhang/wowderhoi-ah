import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateLuaRules } from "./gen-lua-rules";

const LUA_PATH = fileURLToPath(new URL("../addon/WoWderhoiAH/GeneratedRules.lua", import.meta.url));

describe("gen-lua-rules", () => {
  // The drift gate: the committed Lua file is the compiled form of the
  // single source of truth (src/lib/market-rules.ts). If someone edits a
  // rule on the TS side and forgets to regenerate — the exact "change one
  // side, forget the other" failure this refactor exists to kill — this
  // assertion fails in CI. Fix: `npm run gen:lua-rules` and commit.
  it("committed GeneratedRules.lua matches the generator output", () => {
    expect(readFileSync(LUA_PATH, "utf8")).toBe(generateLuaRules());
  });

  it("emits the pipeline version and every radar threshold the addon reads", () => {
    const lua = generateLuaRules();
    expect(lua).toContain("WAH.PIPELINE_VERSION = 3");
    expect(lua).toContain("minProfit = 500");
    expect(lua).toContain("discount = 0.85");
    expect(lua).toContain("minAuctions = 3");
    expect(lua).toContain("minHistory = 3");
  });
});
