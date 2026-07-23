import { describe, expect, it } from "vitest";
import type { MarketHistory } from "@/lib/market-data";
import { createMarketSignalSource } from "./market-signals";

function historyItem(itemId: number, marketPrice: number): MarketHistory {
  return {
    itemId,
    name: `Item ${itemId}`,
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    snapshots: [
      { timestamp: new Date("2026-07-20T10:00:00Z"), minPrice: marketPrice - 5, marketPrice, quantity: 3, numAuctions: 1 }
    ],
    dailySummaries: []
  } as unknown as MarketHistory;
}

describe("createMarketSignalSource", () => {
  it("fetches the universe once per snapshot generation", async () => {
    let universeFetches = 0;
    const source = createMarketSignalSource({
      getLatestSnapshotTime: async () => new Date("2026-07-20T10:00:00Z"),
      getMarketUniverse: async () => {
        universeFetches += 1;
        return [historyItem(1, 100)];
      }
    });
    const first = await source.getMarketSignals();
    const second = await source.getMarketSignals();
    expect(universeFetches).toBe(1);
    expect(second.signals).toBe(first.signals);
    expect(first.signals[0].itemId).toBe(1);
    expect(first.latestSnapshotAt?.toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });

  it("recomputes when a newer snapshot lands", async () => {
    let generation = new Date("2026-07-20T10:00:00Z");
    let price = 100;
    const source = createMarketSignalSource({
      getLatestSnapshotTime: async () => generation,
      getMarketUniverse: async () => [historyItem(1, price)]
    });
    const first = await source.getMarketSignals();
    generation = new Date("2026-07-20T10:15:00Z");
    price = 200;
    const second = await source.getMarketSignals();
    expect(first.signals[0].price).toBe(100);
    expect(second.signals[0].price).toBe(200);
  });

  it("returns empty signals without caching when the store has no snapshots", async () => {
    let universeFetches = 0;
    const source = createMarketSignalSource({
      getLatestSnapshotTime: async () => null,
      getMarketUniverse: async () => {
        universeFetches += 1;
        return [];
      }
    });
    expect((await source.getMarketSignals()).signals).toEqual([]);
    expect((await source.getMarketSignals()).signals).toEqual([]);
    expect(universeFetches).toBe(0);
  });
});
