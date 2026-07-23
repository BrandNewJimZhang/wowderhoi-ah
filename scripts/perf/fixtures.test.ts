import { describe, expect, it } from "vitest";
import { normalizeAddonScan } from "@/lib/addon-scan";
import { buildScanPayload, generateMarket } from "./fixtures";

describe("generateMarket", () => {
  it("is deterministic for the same seed", () => {
    const a = generateMarket({ itemCount: 50, depth: 10, seed: 7 });
    const b = generateMarket({ itemCount: 50, depth: 10, seed: 7 });
    expect(a).toEqual(b);
  });

  it("differs for different seeds", () => {
    const a = generateMarket({ itemCount: 50, depth: 10, seed: 7 });
    const b = generateMarket({ itemCount: 50, depth: 10, seed: 8 });
    expect(a).not.toEqual(b);
  });

  it("respects itemCount and depth with unique positive itemIds", () => {
    const market = generateMarket({ itemCount: 120, depth: 6, seed: 1 });
    expect(market.items).toHaveLength(120);
    const ids = new Set(market.items.map((item) => item.itemId));
    expect(ids.size).toBe(120);
    for (const item of market.items) {
      expect(item.itemId).toBeGreaterThan(0);
      expect(item.walk).toHaveLength(6);
    }
  });

  it("produces positive integer prices with minPrice never above marketPrice", () => {
    const market = generateMarket({ itemCount: 200, depth: 20, seed: 3 });
    for (const item of market.items) {
      for (const point of item.walk) {
        expect(Number.isInteger(point.marketPrice)).toBe(true);
        expect(Number.isInteger(point.minPrice)).toBe(true);
        expect(point.marketPrice).toBeGreaterThan(0);
        expect(point.minPrice).toBeGreaterThan(0);
        expect(point.minPrice).toBeLessThanOrEqual(point.marketPrice);
        expect(point.quantity).toBeGreaterThan(0);
        expect(point.numAuctions).toBeGreaterThan(0);
      }
    }
  });

  it("includes bait listings: some points discount minPrice well below market", () => {
    const market = generateMarket({ itemCount: 300, depth: 10, seed: 5 });
    const baitPoints = market.items
      .flatMap((item) => item.walk)
      .filter((point) => point.minPrice < point.marketPrice * 0.75);
    expect(baitPoints.length).toBeGreaterThan(0);
  });
});

describe("buildScanPayload", () => {
  it("produces a payload the real import validator accepts verbatim", () => {
    const market = generateMarket({ itemCount: 80, depth: 4, seed: 2 });
    const scannedAt = 1_800_000_000;
    const payload = buildScanPayload(market, 3, scannedAt);
    const scan = normalizeAddonScan(payload);
    expect(scan.items).toHaveLength(80);
    expect(scan.scannedAt.getTime()).toBe(scannedAt * 1000);
    expect(scan.server).toBeTruthy();
    expect(scan.faction).toBeTruthy();
  });

  it("rejects a walk index beyond the generated depth", () => {
    const market = generateMarket({ itemCount: 10, depth: 4, seed: 2 });
    expect(() => buildScanPayload(market, 4, 1_800_000_000)).toThrow(/depth/);
  });
});
