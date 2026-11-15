// The decision core is the one authority both runtimes run. Its contract is
// that it is a pure function of the input table plus the compiled rule pack:
// no client API, no clock, no SavedVariables. That promise lived only in a
// comment; a single GetMoney() added later would make the terminal and the
// game disagree while every behaviour test still passed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "WoWderhoiAH",
  "Core.lua"
);

// Block comments first, then line comments. Prose may name an API; only code
// counts.
function executableSource(source: string): string {
  return source
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const code = executableSource(fs.readFileSync(CORE_PATH, "utf8"));

describe("decision core purity", () => {
  it("calls no client or clock API", () => {
    const forbidden = [
      /\bC_[A-Za-z]/,
      /\bGetMoney\b/,
      /\bGetItemInfo\b/,
      /\bGetItemIconByID\b/,
      /\bUnitName\b/,
      /\bUnitFactionGroup\b/,
      /\bGetRealmName\b/,
      /\bGetLocale\b/,
      /\bCreateFrame\b/,
      /\bGetTime\b/,
      /\btime\s*\(/,
      /\bdate\s*\(/,
      /\bwipe\s*\(/,
      /\bos\./
    ];
    for (const pattern of forbidden) {
      expect(code, `Core.lua must not reference ${pattern}`).not.toMatch(pattern);
    }
  });

  it("reads only the compiled rule pack from the addon namespace", () => {
    const names = new Set(
      Array.from(code.matchAll(/\bWAH\.([A-Za-z_]\w*)/g), (match) => match[1])
    );
    // The rule pack is the core's one environment input: rules, the event
    // calendar and the demand table ship together from the same generator.
    // Core is the export every other file reads.
    expect([...names].sort()).toEqual(["Core", "DEMAND", "EVENTS", "RULES"]);
  });
});
