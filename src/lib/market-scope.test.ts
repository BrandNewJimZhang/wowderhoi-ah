import { afterAll, describe, expect, it, vi } from "vitest";
import { parseMarketPin, resolveMarketScope } from "@/lib/market-scope";

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

const savedPin = process.env.AQT_MARKET;
delete process.env.AQT_MARKET;
afterAll(() => {
  if (savedPin === undefined) delete process.env.AQT_MARKET;
  else process.env.AQT_MARKET = savedPin;
});

const market = { id: "m1", realm: "R", faction: "F", openedAt: null, firstScanAt: null, dataVersion: 7 };

function fakeClient(options: { estate?: unknown } = {}) {
  return {
    market: {
      findUnique: vi.fn(async () => market),
      findFirst: vi.fn(async () => market)
    },
    marketGeneration: {
      findFirst: vi.fn(async () => ({ marketId: market.id, character: "Scanned" }))
    },
    estate: {
      findFirst: vi.fn(async () => options.estate ?? null),
      findUnique: vi.fn(async () => null)
    }
  };
}

describe("resolveMarketScope", () => {
  it("follows the latest estate observation, not the latest scan", async () => {
    const scope = await resolveMarketScope(fakeClient({
      estate: { scope: "character:Pushed", cash: 1234, freeSlots: 4, revision: 9 }
    }) as never);
    expect(scope).toMatchObject({
      character: "Pushed",
      cash: 1234,
      bagSlots: 4,
      estateRevision: 9
    });
  });

  it("falls back to the scan character when no estate has been observed", async () => {
    const scope = await resolveMarketScope(fakeClient() as never);
    expect(scope).toMatchObject({
      character: "Scanned",
      cash: null,
      bagSlots: null,
      estateRevision: 0
    });
  });
});
