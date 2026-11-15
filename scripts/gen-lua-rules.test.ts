import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";
import {
  generateLuaRules,
  generateRulesRevisionModule,
  rulesBody,
  rulesRevision
} from "./gen-lua-rules";

const LUA_PATH = fileURLToPath(new URL("../addon/WoWderhoiAH/GeneratedRules.lua", import.meta.url));
const REVISION_PATH = fileURLToPath(new URL("../src/lib/generated-rules-revision.ts", import.meta.url));

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
    expect(generateLuaRules()).toContain(`WAH.PIPELINE_VERSION = ${SCAN_PIPELINE_VERSION}`);
  });

  it("versions the rule pack by its content, not a hand-maintained integer", () => {
    const body = rulesBody();
    const revision = rulesRevision(body);
    expect(revision).toMatch(/^[0-9a-f]{12}$/);
    expect(generateLuaRules()).toContain(`WAH.RULES_REVISION = "${revision}"`);
    // The terminal reads the same constant, so one hash names the rules
    // both runtimes execute.
    expect(readFileSync(REVISION_PATH, "utf8")).toBe(generateRulesRevisionModule());
    expect(generateRulesRevisionModule()).toContain(`RULES_REVISION = "${revision}"`);
    // Stable for the same body, different for an edited one.
    expect(rulesRevision(body)).toBe(revision);
    expect(rulesRevision(`${body}-- edited\n`)).not.toBe(revision);
    // The scan's wire-format version is not rule content: bumping the
    // pipeline must not invalidate every published plan on its own.
    expect(body).not.toContain("WAH.PIPELINE_VERSION");
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
