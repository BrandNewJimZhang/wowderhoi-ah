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

  it("emits the pipeline version", () => {
    expect(generateLuaRules()).toContain("WAH.PIPELINE_VERSION = 4");
  });

  it("emits the phase and market-type matrix the decision core reads", () => {
    const lua = generateLuaRules();
    expect(lua).toContain("WAH.RULES =");
    expect(lua).toContain("feeRate = 0.05");
    expect(lua).toContain("marketTypeRules =");
    for (const phase of ["ignition", "wave", "settle", "steady"]) {
      expect(lua).toContain(`${phase} = {`);
    }
    for (const type of ["commodity", "item"]) {
      expect(lua).toContain(`${type} = {`);
    }
    // Vendor arbitrage bypasses the gate matrix; compiling a vendor block
    // would ship thresholds no code reads.
    expect(lua).not.toContain("vendor = {");
    expect(lua).toContain("minUnitProfit = 250"); // steady/item is the strictest
  });
});
