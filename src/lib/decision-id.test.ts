import { describe, expect, it } from "vitest";
import { decisionIdFor } from "@/lib/decision-id";

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

  it("separates kinds and items", () => {
    const at = 1_700_000_000;
    expect(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "buy" }))
      .not.toBe(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "sell" }));
    expect(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 1, kind: "buy" }))
      .not.toBe(decisionIdFor({ realm: "R", faction: "A", scannedAt: at, itemId: 2, kind: "buy" }));
  });
});
