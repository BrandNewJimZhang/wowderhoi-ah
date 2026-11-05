import { describe, expect, it } from "vitest";
import type { MarketHistory } from "@/lib/market-data";
import { createMarketSignalSource } from "./market-signals";

const LATEST = new Date("2026-07-20T10:00:00Z");

function historyItem(itemId: number, sellPrice: number, timestamp: Date = LATEST): MarketHistory {
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
        timestamp,
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

function fetchers(universe: MarketHistory[], latest: Date = LATEST) {
  return {
    getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
    getLatestSnapshotTime: async () => latest,
    getEarliestSnapshotTime: async () => universe.length > 0 ? universe[0].snapshots[0].timestamp : null,
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

  it("recommends nothing for a character whose scan saw an empty purse", async () => {
    const source = createMarketSignalSource({
      ...fetchers([historyItem(1, 200)]),
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0, character: "Tester" })
    });
    const bundle = await source.getMarketSignals();
    // The market rows still exist -- the book is real -- but nothing is
    // affordable, exactly as the in-game radar behaves with 0 copper.
    expect(bundle.evaluation.rows).toHaveLength(0);
    expect(bundle.evaluation.actions).toHaveLength(0);
  });

  it("scopes every market read to the selected realm and faction", async () => {
    const seen: string[] = [];
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
      getLatestSnapshotTime: async (scope) => { seen.push(scope?.id ?? "none"); return LATEST; },
      getEarliestSnapshotTime: async (scope) => { seen.push(scope?.id ?? "none"); return LATEST; },
      getMarketUniverse: async (scope) => { seen.push(scope?.id ?? "none"); return [historyItem(1, 200)]; },
      getPositions: async (scope) => { seen.push(scope?.id ?? "none"); return {}; },
      getOwnSales: async (scope) => { seen.push(scope?.id ?? "none"); return {}; }
    });
    const bundle = await source.getMarketSignals();
    expect(bundle.scope?.id).toBe("m1");
    expect(seen).toEqual(["m1", "m1", "m1", "m1", "m1"]);
  });

  it("does not serve one market's bundle to another market with the same timestamp", async () => {
    // Two realms can be imported from the same SavedVariables write, so a
    // timestamp alone is not a safe cache key.
    let scopeId = "m1";
    let marker = "first";
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: scopeId, realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
      getLatestSnapshotTime: async () => LATEST,
      getEarliestSnapshotTime: async () => LATEST,
      getMarketUniverse: async () => {
        const item = historyItem(1, 200);
        item.name = marker;
        return [item];
      },
      getPositions: async () => ({}),
      getOwnSales: async () => ({})
    });
    expect((await source.getMarketSignals()).signals[0].name).toBe("first");
    scopeId = "m2";
    marker = "second";
    expect((await source.getMarketSignals()).signals[0].name).toBe("second");
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
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
      getLatestSnapshotTime: async () => generation,
      getEarliestSnapshotTime: async () => LATEST,
      getMarketUniverse: async () => [historyItem(1, price, generation)],
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

  it("evaluates the market under the same phase the bundle reports", async () => {
    // A mature market: observed for 30 hours, 100 priced items, newest scan
    // minutes ago. Before the phase was handed to the core, the core derived
    // age from the newest snapshot and silently evaluated every live market
    // under the ignition rules while the banner said wave.
    const latest = new Date(Date.now() - 5 * 60 * 1000);
    const earliest = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const universe = Array.from({ length: 100 }, (_, index) => {
      const item = historyItem(index + 1, 200, latest);
      item.snapshots = [
        { ...item.snapshots[0], timestamp: earliest },
        { ...item.snapshots[0], timestamp: latest }
      ];
      return item;
    });
    const bundle = await createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
      getLatestSnapshotTime: async () => latest,
      getEarliestSnapshotTime: async () => earliest,
      getMarketUniverse: async () => universe,
      getPositions: async () => ({}),
      getOwnSales: async () => ({})
    }).getMarketSignals();
    expect(bundle.phase).toBe("wave");
    expect(bundle.evaluation.phase).toBe(bundle.phase);
  });

  it("advances the phase when time crosses a boundary without a new scan", async () => {
    // In game WAH.currentPhase() runs on every call, so a paused scan still
    // matures the market. The terminal cache used to freeze the phase until
    // the next import, leaving a stale ignition banner over ignition gates.
    const opened = new Date("2026-07-20T00:00:00Z");
    let clock = opened;
    let universeFetches = 0;
    const universe = Array.from({ length: 100 }, (_, index) => historyItem(index + 1, 200, opened));
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
      getLatestSnapshotTime: async () => opened,
      getEarliestSnapshotTime: async () => opened,
      getMarketUniverse: async () => {
        universeFetches += 1;
        return universe;
      },
      getPositions: async () => ({}),
      getOwnSales: async () => ({}),
      now: () => clock
    });
    expect((await source.getMarketSignals()).phase).toBe("ignition");
    clock = new Date(opened.getTime() + 7 * 60 * 60 * 1000);
    const matured = await source.getMarketSignals();
    expect(matured.phase).toBe("wave");
    expect(matured.evaluation.phase).toBe("wave");
    expect(universeFetches).toBe(2);
    // The same generation still hits the cache after the rebuild.
    await source.getMarketSignals();
    expect(universeFetches).toBe(2);
  });

  it("marks items missing from the newest scan as stale and keeps them out of the core", async () => {
    const older = new Date("2026-07-20T09:00:00Z");
    const universe = [historyItem(1, 200, LATEST), historyItem(2, 1000, older)];
    const bundle = await createMarketSignalSource(fetchers(universe)).getMarketSignals();
    expect(bundle.signals).toHaveLength(2);
    expect(bundle.signals.find((signal) => signal.itemId === 2)?.stale).toBe(true);
    expect(bundle.signals.find((signal) => signal.itemId === 1)?.stale).toBe(false);
    // The stale item would have cleared every ignition gate on paper; it is
    // excluded because its book no longer exists.
    expect(bundle.evaluation.rows.map((row) => row.itemId)).toEqual([1]);
    expect(bundle.evaluation.actions.every((action) => action.itemId === 1)).toBe(true);
  });

  it("counts breadth from the newest scan, not from every retained item", async () => {
    // 100 items were listed 30 hours ago; only one is listed now. Counting
    // the history would put the market in wave, while the in-game scanner
    // (which only sees the current scan) still reports ignition breadth.
    const older = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const latest = new Date(Date.now() - 60 * 1000);
    const universe = [
      ...Array.from({ length: 100 }, (_, index) => historyItem(index + 1, 200, older)),
      historyItem(999, 200, latest)
    ];
    const bundle = await createMarketSignalSource(fetchers(universe, latest)).getMarketSignals();
    expect(bundle.phase).toBe("ignition");
  });

  it("returns empty signals without caching when the store has no snapshots", async () => {
    let universeFetches = 0;
    const source = createMarketSignalSource({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester" }),
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
