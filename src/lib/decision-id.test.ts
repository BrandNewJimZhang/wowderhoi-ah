import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decisionIdFor } from "@/lib/decision-id";

const ADDON_PATH = fileURLToPath(new URL("../../addon/WoWderhoiAH/WoWderhoiAH.lua", import.meta.url));

// The addon reproduces the identity so `/wahadopt` can name a decision it
// cannot import from TS. Like GeneratedRules.lua, the copy is a contract:
// if either side changes the layout, adoption silently stops matching and
// every decision looks unadopted in the review.
function luaDecisionIdFunction(): string {
  const source = readFileSync(ADDON_PATH, "utf8");
  const match = source.match(/\nfunction WAH\.decisionId\([^)]*\)\n([\s\S]*?)\nend\n/);
  if (!match) throw new Error("WAH.decisionId not found in the addon source");
  return match[1];
}

describe("decisionIdFor", () => {
  it("formats the identity from a Date and from epoch seconds the same way", () => {
    const at = new Date("2026-11-08T07:58:00Z");
    const epoch = Math.round(at.getTime() / 1000);
    const identity = { realm: "CN5 Realm 8 PvP", faction: "Alliance", itemId: 2589, kind: "buy" };
    expect(decisionIdFor({ ...identity, scannedAt: at })).toBe(
      `CN5 Realm 8 PvP|Alliance|${epoch}:2589:buy`
    );
    expect(decisionIdFor({ ...identity, scannedAt: epoch })).toBe(
      `CN5 Realm 8 PvP|Alliance|${epoch}:2589:buy`
    );
  });

  // The in-game command builds the id from the addon's own copy of the
  // formula; the terminal must produce a string that copy could have
  // produced. Field order is part of the identity, so it is asserted too.
  it("matches the in-game /wahadopt formula", () => {
    const body = luaDecisionIdFunction();
    const format = body.match(/string\.format\("([^"]+)"/)?.[1];
    expect(format).toBe("%s|%s|%d:%d:%s");
    expect(body).toContain('tostring(scan.server or "")');
    expect(body).toContain('tostring(scan.faction or "")');
    expect(body).toContain('scan.scannedAt, tonumber(itemId) or 0, tostring(kind or "")');

    const tsId = decisionIdFor({
      realm: "CN5 Realm 8 PvP",
      faction: "Alliance",
      scannedAt: 1_700_000_000,
      itemId: 2589,
      kind: "buy"
    });
    // A realm name can contain spaces, so the only safe reading of the id is
    // the Lua format's own separators.
    const pattern = new RegExp(
      `^${format!.replace(/[.]/g, "\\.").replace(/%s/g, ".+?").replace(/%d/g, "\\d+")}$`
    );
    expect(tsId).toMatch(pattern);
  });

  it("separates kinds and items", () => {
    const at = 1_700_000_000;
    expect(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "buy" }))
      .not.toBe(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "sell" }));
    expect(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "buy" }))
      .not.toBe(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 2, kind: "buy" }));
  });
});
