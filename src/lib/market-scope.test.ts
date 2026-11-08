import { describe, expect, it } from "vitest";
import { parseMarketPin } from "@/lib/market-scope";

describe("parseMarketPin", () => {
  it("splits a realm|faction pin", () => {
    expect(parseMarketPin("CN5 Realm 8 PvP|Alliance")).toEqual({
      realm: "CN5 Realm 8 PvP",
      faction: "Alliance"
    });
  });

  it("treats an unset or empty pin as no pin", () => {
    expect(parseMarketPin(undefined)).toBeNull();
    expect(parseMarketPin("")).toBeNull();
  });

  it("rejects a malformed pin instead of widening the query", () => {
    expect(() => parseMarketPin("NoFaction")).toThrow(/realm\|faction/);
    expect(() => parseMarketPin("|Alliance")).toThrow(/realm\|faction/);
    expect(() => parseMarketPin("Realm|")).toThrow(/realm\|faction/);
    expect(() => parseMarketPin("Realm|Alliance|extra")).toThrow(/realm\|faction/);
  });
});
