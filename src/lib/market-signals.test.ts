import { describe, expect, it } from "vitest";
import type { MarketHistory } from "@/lib/market-data";
import { createMarketSignalSource } from "./market-signals";

function historyItem(itemId: number, sellPrice: number): MarketHistory {
  const minPrice = Math.round(sellPrice * 0.5);
  return {
    itemId,
    name: `Item ${itemId}`,
    quality: "common",
    category: "Trade Goods",
    subCategory: "Herb",
    vendorPrice: 0,
    snapshots: [
      {
        timestamp: new Date("2026-07-20T10:00:00Z"),
        minPrice,
        marketPrice: sellPrice,
        sellPrice,
        p5Price: minPrice,
        quantity: 200,
        numAuctions: 10,
        sellerCount: 4,
        sellersInvisible: false,
        bidOnlyCount: 0,
        soldProxyLow: 0,
        soldProxyHigh: 0,
        supplyGrowth: 0,
        topTiers: [{ p: minPrice, q: 100 }, { p: Math.round(sellPrice * 0.75), q: 100 }],
        expiring: { soon: 1, mid: 2, late: 3 }
      }
    ],
    dailySummaries: []
  } as unknown as MarketHistory;
}

function fetchers(universe: MarketHistory[]) {
  return {
    getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0 }),
    getLatestSnapshotTime: async () => new Date("2026-07-20T10:00:00Z"),
    getEarliestSnapshotTime: async () => new Date("2026-07-20T10:00:00Z"),
    getMarketUniverse: async () => universe,
    getPositions: async () => ({}),
    getOwnSales: async () => ({})
  };
}

describe("createMarketSignalSource", () => {
  it("fetches the universe once per snapshot generation", async () => {
    let universeFetches = 0;
    const source = createMarketSignalSource({
      ...fetchers([historyItem(1, 200)]),
      getMarketUniverse: async () => {
        universeFetches += 1;
        return [historyItem(1, 200)];
      }
    });
    const first = await source.getMarketSignals();
    const second = await source.getMarketSignals();
    expect(universeFetches).toBe(1);
    expect(second.signals).toBe(first.signals);
    expect(first.signals[0].itemId).toBe(1);
    expect(first.latestSnapshotAt?.toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });

  it("runs the shared decision core and returns executable rows", async () => {
    const bundle = await createMarketSignalSource(fetchers([historyItem(1, 200)])).getMarketSignals();
    // Breadth 1 keeps the market in ignition; the 50% spread is executable.
    expect(bundle.phase).toBe("ignition");
    expect(bundle.evaluation.rows).toHaveLength(1);
    expect(bundle.evaluation.rows[0].sellP).toBeGreaterThan(0);
    expect(bundle.evaluation.actions.some((action) => action.kind === "buy")).toBe(true);
  });

  it("scopes every market read to the selected realm and faction", async () => {
    const seen: string[] = [];
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0 }),
      getLatestSnapshotTime: async (scope) => { seen.push(scope?.id ?? "none"); return new Date("2026-07-20T10:00:00Z"); },
      getEarliestSnapshotTime: async (scope) => { seen.push(scope?.id ?? "none"); return new Date("2026-07-20T10:00:00Z"); },
      getMarketUniverse: async (scope) => { seen.push(scope?.id ?? "none"); return [historyItem(1, 200)]; },
      getPositions: async (scope) => { seen.push(scope?.id ?? "none"); return {}; },
      getOwnSales: async (scope) => { seen.push(scope?.id ?? "none"); return {}; }
    });
    const bundle = await source.getMarketSignals();
    expect(bundle.scope?.id).toBe("m1");
    expect(seen).toEqual(["m1", "m1", "m1", "m1", "m1"]);
  });

  it("records decisions once per scan generation", async () => {
    const recorded: unknown[] = [];
    const source = createMarketSignalSource({
      ...fetchers([historyItem(1, 200)]),
      recordDecisions: async (bundle) => { recorded.push(bundle); }
    });
    await source.getMarketSignals();
    await source.getMarketSignals();
    expect(recorded).toHaveLength(1);
  });

  it("recomputes when a newer snapshot lands", async () => {
    let generation = new Date("2026-07-20T10:00:00Z");
    let price = 200;
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0 }),
      getLatestSnapshotTime: async () => generation,
      getEarliestSnapshotTime: async () => new Date("2026-07-20T10:00:00Z"),
      getMarketUniverse: async () => [historyItem(1, price)],
      getPositions: async () => ({}),
    getOwnSales: async () => ({})
    });
    const first = await source.getMarketSignals();
    generation = new Date("2026-07-20T10:15:00Z");
    price = 400;
    const second = await source.getMarketSignals();
    expect(first.signals[0].sellPrice).toBe(200);
    expect(second.signals[0].sellPrice).toBe(400);
  });

  it("returns empty signals without caching when the store has no snapshots", async () => {
    let universeFetches = 0;
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0 }),
      getLatestSnapshotTime: async () => null,
      getEarliestSnapshotTime: async () => null,
      getMarketUniverse: async () => {
        universeFetches += 1;
        return [];
      },
      getPositions: async () => ({}),
    getOwnSales: async () => ({})
    });
    expect((await source.getMarketSignals()).signals).toEqual([]);
    expect((await source.getMarketSignals()).signals).toEqual([]);
    expect(universeFetches).toBe(0);
  });
});
