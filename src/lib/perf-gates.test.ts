// Unit-level performance gates for the economic system. The HTTP-level
// budgets live in scripts/perf; these catch the stages that run on every
// scan generation or import before they become a page-level stall.
//
// The core budget is deliberately looser than the in-game frame budget:
// the terminal runs Core.lua inside fengari, a JavaScript Lua VM, while
// the addon runs the same file on the client's native Lua.
import { describe, expect, it } from "vitest";
import { buildMarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreInput } from "@/lib/core/types";
import type { MarketQuote, SignalItem } from "@/lib/market-data";
import { buildGenerationPlan } from "@/lib/market-generation";
import { filterSortSignals } from "@/lib/market-filter";
import type { AddonScan, AddonScanItem } from "@/lib/addon-scan";
import type { SeriesPoint } from "@/lib/item-series";
import { solveProduction, type LpRecipe } from "@/lib/craft-lp";
import { replayJournal, type JournalEvent } from "@/lib/journal";
import { loadRecipeDataset, recipeToLp } from "@/lib/recipes";
import { normalizeAddonScan } from "@/lib/addon-scan";
import { productionCapacity } from "@/lib/production-config";
import { loadAddon } from "../../addon/test/wow-lua";

const NOW = 1_800_000_000;

// Budgets include headroom for a loaded CI box: the whole suite runs test
// files in parallel, so a stage that takes 125ms alone can take 3-4x that
// while competing for a core. These gates catch order-of-magnitude
// regressions; the standalone measurement is recorded in the docs.
//
// Stages are measured in process CPU time, not wall-clock: a contended
// worker can spend seconds descheduled while doing the same work, and that
// descheduling says nothing about the code under test.
const budgets = {
  core866Ms: 1000,
  // A 250k-listing market collapses to roughly 6k item books; the whole
  // cockpit evaluation runs once per scan generation at that size.
  core6000Ms: 4000,
  buildInputMs: 100,
  lp120Ms: 200,
  scan9000Ms: 1000,
  // Full replicate scan: 250,000 listings into 6,000 item books, including
  // the flow capture and series write. Fengari is much slower than the
  // client's native Lua, so the gate catches order-of-magnitude regressions.
  scan250kMs: 40_000,
  // The three SavedVariables tables a 250k-listing market produces. The
  // budget sits above the fixture's current size so a deliberate field
  // addition has room, while a per-row table regression (the shape this
  // project already removed once) fails the gate.
  scanPayloadBytes: 8 * 1024 * 1024,
  // Per-frame finish budget. The client budget is 8ms. The mean is the real
  // slicing gate: an unsliced finish puts the whole aggregation in one
  // frame, so its mean is hundreds of milliseconds. Fengari can still run a
  // GC cycle inside a single frame, so the maximum gets a wider outlier
  // bound instead of pretending a VM pause is the addon's schedule.
  scanFinishFrameMeanMs: 50,
  scanFinishFrameMaxMs: 300
};

function cpuMsSince(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
}

function coreInput(itemCount: number): CoreInput {
  const items: CoreInput["market"]["items"] = {};
  for (let index = 0; index < itemCount; index += 1) {
    const min = 100 + index;
    items[10_000 + index] = {
      name: `Item ${index}`,
      itemClass: "Trade Goods",
      vendorP: 1,
      minPrice: min,
      sellP: min + 200,
      quantity: 200,
      numAuctions: 10,
      sellers: 4,
      tiers: [{ p: min, q: 50 }, { p: min + 100, q: 150 }],
      history: { samples: 8 },
      inferredSoldLow: 10,
      inferredSoldHigh: 10,
      elapsedHours: 0.25
    };
  }
  return {
    now: NOW,
    phaseOverride: "wave",
    market: { firstScanAt: NOW - 30 * 3600, items },
    capital: { cash: 1_000_000, budget: 1_000_000 },
    capacity: { bagSlots: 20, stackSize: 20 }
  };
}

describe("system performance gates", () => {
  it("evaluates 866 items through the shared core inside the gate (warm)", () => {
    const input = coreInput(866);
    runCore(input); // warm the Lua state and template caches
    const start = process.cpuUsage();
    const output = runCore(input);
    const elapsed = cpuMsSince(start);
    expect(output.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(budgets.core866Ms);
  });

  it("evaluates 6,000 items (a 250k-listing market) inside the gate (warm)", () => {
    const input = coreInput(6000);
    runCore(input); // warm the Lua state and template caches
    const start = process.cpuUsage();
    const output = runCore(input);
    const elapsed = cpuMsSince(start);
    expect(output.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(budgets.core6000Ms);
  });

  it("builds the core input for 866 items inside the gate", () => {
    const timestamp = new Date(NOW * 1000);
    const pairs = Array.from({ length: 866 }, (_, index) => {
      const quote: MarketQuote = {
        timestamp, priced: true, minPrice: 100 + index, marketPrice: 110 + index, sellPrice: 120 + index,
        p5Price: 105 + index, quantity: 200, numAuctions: 10, sellerCount: 4, sellersInvisible: false,
        ownerVisible: true, observationVersion: 2, sellerHHI: null, topSellerShare: null,
        marketType: "commodity", bidOnlyCount: 0, highestBid: 0, soldProxyLow: 0, soldProxyHigh: 0,
        flowObserved: true, supplyGrowth: 0, historySamples: 2, historySpanHours: 1,
        tierTruncated: false, topTiers: [{ p: 100 + index, q: 100 }, { p: 120 + index, q: 100 }],
        expiring: null
      };
      const series = [{
        t: NOW, minPrice: 100 + index, sellPrice: 120 + index, quantity: 200, numAuctions: 10, event: false
      }, {
        t: NOW - 900, minPrice: 100 + index, sellPrice: 118 + index, quantity: 190, numAuctions: 9, event: false
      }];
      const signal = buildMarketSignal({
        item: {
          itemId: 10_000 + index, name: `Item ${index}`, quality: "common", category: "Trade Goods",
          subCategory: "Herb", vendorPrice: 0, iconId: null
        },
        quote,
        series
      }, timestamp, { phase: "wave" });
      return { signal, quote, previousAt: new Date((NOW - 900) * 1000) };
    });
    const start = process.cpuUsage();
    const input = buildCoreInput(pairs, { now: timestamp, phase: "wave", budgetCopper: 1_000_000 });
    expect(Object.keys(input.market.items)).toHaveLength(866);
    expect(cpuMsSince(start)).toBeLessThan(budgets.buildInputMs);
  });

  it("replays a 5,000-event journal inside the gate", () => {
    const events: JournalEvent[] = [];
    for (let index = 0; index < 5000; index += 1) {
      events.push(index % 2 === 0
        ? { k: "buy", t: index, itemId: 1 + (index % 100), qty: 1, cost: 100 }
        : { k: "vendor", t: index, itemId: 1 + (index % 100), qty: 1, paid: 120 });
    }
    const start = process.cpuUsage();
    const state = replayJournal(events);
    expect(Object.keys(state.positions).length).toBe(50);
    expect(cpuMsSince(start)).toBeLessThan(budgets.buildInputMs);
  });

  it("solves 120 production candidates inside the gate", () => {
    const dataset = loadRecipeDataset();
    const recipes: LpRecipe[] = dataset.recipes.map(recipeToLp);
    const prices = new Map<number, number>();
    for (let index = 0; index < 3000; index += 1) prices.set(index, 100 + index);
    const start = process.cpuUsage();
    const solution = solveProduction(recipes, {
      prices,
      capacity: productionCapacity,
      budget: 500_000,
      feeRate: 0.05,
      maxCandidates: 120
    });
    expect(solution.candidates).toBeGreaterThan(0);
    expect(cpuMsSince(start)).toBeLessThan(budgets.lp120Ms);
  });

  it("validates a 9,000-item scan inside the gate", () => {
    const items: Record<string, unknown> = {};
    for (let index = 0; index < 9000; index += 1) {
      items[String(100_000 + index)] = {
        name: `Item ${index}`,
        quality: 1,
        itemClass: "Trade Goods",
        minPrice: 100 + index,
        sellP: 120 + index,
        marketPrice: 110 + index,
        p5: 101 + index,
        quantity: 100,
        numAuctions: 5,
        sellers: 3,
        bidOnly: 0,
        tiers: [{ p: 100 + index, q: 40 }, { p: 120 + index, q: 60 }],
        expiring: { soon: 1, mid: 1, late: 3 }
      };
    }
    const start = process.cpuUsage();
    const scan = normalizeAddonScan({
      dataVersion: 4,
      scannedAt: NOW,
      server: "PerfRealm",
      faction: "Alliance",
      character: "Tester",
      total: 9000,
      items
    });
    expect(scan.items).toHaveLength(9000);
    expect(cpuMsSince(start)).toBeLessThan(budgets.scan9000Ms);
  });

  it("walks a 250,000-listing replicate scan inside the gate", () => {
    const lua = loadAddon();
    lua.exec(`
      WowTest.fireEvent('AUCTION_HOUSE_SHOW')
      -- Rows are generated in Lua: a 250k-element JS-to-Lua conversion
      -- would measure the test bridge, not the scanner.
      local ITEMS, LISTINGS = 6000, 250000
      local replicate, itemInfo = WowTest.ah.replicate, WowTest.itemInfo
      for i = 1, ITEMS do
        itemInfo[10000 + i] = { name = "Item " .. i, class = "Trade Goods", subClass = "Other", vendorP = 10 }
      end
      for n = 1, LISTINGS do
        local i = (n - 1) % ITEMS + 1
        replicate[n] = {
          itemId = 10000 + i,
          name = "Item " .. i,
          count = 1 + (n % 5),
          buyout = (100 + (math.floor(n / ITEMS) % 8) * 25) * (1 + (n % 5)),
          quality = 2,
          owner = "Seller" .. ((n % 200) + 1),
          timeLeft = 3600 * (1 + (n % 40))
        }
      end
      -- Measure the real per-frame budget path instead of the stub's
      -- never-trip clock: the scanner then slices work the way it does
      -- in the client.
      function debugprofilestop() return os.clock() * 1000 end
      WowTest.scanStart = os.clock()
      WowTest.ns.startScan()
      WowTest.fireEvent('AUCTION_HOUSE_BROWSE_RESULTS_UPDATED')
      local guard = 0
      while WowTest.ns.scanRunning do
        for _, frame in ipairs(WowTest.frames) do
          local update = frame._scripts and frame._scripts.OnUpdate
          if update then update(frame) end
        end
        guard = guard + 1
        if guard > 100000 then error('scan did not finish') end
      end
      WowTest.scanElapsedMs = (os.clock() - WowTest.scanStart) * 1000
      WowTest.scannedItems = 0
      for _ in pairs(WoWderhoiAH_ScanData.items) do WowTest.scannedItems = WowTest.scannedItems + 1 end
      WowTest.capturedItems = 0
      for _ in pairs(WoWderhoiAH_Capture.items) do WowTest.capturedItems = WowTest.capturedItems + 1 end
    `);
    const elapsed = lua.number("WowTest.scanElapsedMs");
    expect(lua.number("WowTest.ns.lastScanStats.rows")).toBe(250_000);
    expect(lua.number("WowTest.scannedItems")).toBe(6000);
    expect(lua.number("WowTest.capturedItems")).toBe(6000);
    expect(elapsed).toBeLessThan(budgets.scan250kMs);
    // The scan reached the saved phase with every row accounted for; the
    // old wall-clock guard could abort a book this size mid-processing.
    expect(lua.eval("WowTest.ns.lastScanStats.reason")).toBeNull();
    expect(lua.text("WowTest.ns.lastScanStats.phase")).toBe("saved");
    expect(lua.number("WowTest.ns.lastScanStats.rows")).toBe(250_000);
    // The finish phase is sliced like the row loop; a single frame that
    // aggregates every book is the stall this gate exists to catch.
    const finishMs = lua.number("WowTest.ns.lastScanStats.finishMs");
    const finishFrameMax = lua.number("WowTest.ns.lastScanStats.finishFrameMaxMs");
    const finishFrames = lua.number("WowTest.ns.lastScanStats.finishFrames");
    expect(finishFrames).toBeGreaterThan(1);
    // The average catches a finish that honors its slice on paper but does
    // too much per frame. Consecutive frames amortise a GC pause, so this
    // assertion stays stable where a per-frame maximum did not.
    expect(finishMs / finishFrames).toBeLessThan(budgets.scanFinishFrameMeanMs);
    expect(finishFrameMax).toBeLessThan(budgets.scanFinishFrameMaxMs);
    // The gate used to assert the journal and call it a scan payload. The
    // three SavedVariables tables are the payload the client serialises and
    // the terminal parses; their real JSON size is what the budget means.
    const payload = lua.value("({ scan = WoWderhoiAH_ScanData, series = WoWDerhoiAH_Series, capture = WoWDerhoiAH_Capture })");
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(payloadBytes).toBeGreaterThan(0);
    expect(payloadBytes).toBeLessThan(budgets.scanPayloadBytes);
  });

  it("builds a 3,692-item generation with series inside the import gate", () => {
    const COUNT = 3692;
    const POINTS = 5;
    const scanSeconds = Math.round(Date.now() / 1000 / 900) * 900;
    const items = new Map<number, SignalItem>();
    const series: Array<{ itemId: number; points: SeriesPoint[] }> = [];
    const scanItems: AddonScanItem[] = [];
    for (let index = 0; index < COUNT; index += 1) {
      const itemId = 10_000 + index;
      const sell = 100 + (index % 500);
      items.set(itemId, {
        itemId, name: `Item ${index}`, quality: "common", category: "商品", subCategory: "草药",
        vendorPrice: 1, iconId: null
      });
      series.push({
        itemId,
        points: Array.from({ length: POINTS }, (_, step) => ({
          t: scanSeconds - (POINTS - 1 - step) * 900,
          minPrice: sell - 10, sellPrice: sell, quantity: 200, numAuctions: 10, event: false
        }))
      });
      scanItems.push({
        itemId, name: `Item ${index}`, quality: "common", category: "商品", subCategory: "草药",
        marketType: "commodity", priced: true, minPrice: sell - 10, marketPrice: sell,
        sellPrice: sell, p5Price: sell - 5, quantity: 200, numAuctions: 10, sellerCount: 4,
        sellersInvisible: false, ownerVisible: false, sellerHHI: null, topSellerShare: null,
        bidOnlyCount: 0, highestBid: 0, inferredSoldLow: 0, inferredSoldHigh: 0, flowObserved: true,
        supplyGrowth: 0, historySamples: POINTS, historySpanHours: 1, vendorPrice: 1,
        tiers: [{ p: sell - 10, q: 100 }, { p: sell, q: 100 }], tierTruncated: false,
        expiring: { soon: 0, mid: 0, late: 0 }
      });
    }
    const scan: AddonScan = {
      scannedAt: new Date(scanSeconds * 1000), server: "R", faction: "A", character: "T",
      cash: 1_000_000, openedAt: null, bagSlots: 20, observationVersion: 2, skippedItems: 0,
      items: scanItems
    };
    const start = process.cpuUsage();
    const plan = buildGenerationPlan({
      scan, series: null, items, existingSeries: series, previous: null,
      openedAt: null, firstScanAt: new Date((scanSeconds - 3 * 86400) * 1000),
      positions: {}, ownSales: {}, budgetCopper: 1_000_000, phaseOverride: null
    });
    expect(plan.signals).toHaveLength(COUNT);
    expect(plan.series).toHaveLength(COUNT);
    expect(cpuMsSince(start)).toBeLessThan(3000);
  });

  it("filters and sorts 4,048 client rows inside the interaction budget", () => {
    const rows = Array.from({ length: 4048 }, (_, index) => ({
      itemId: index,
      name: `亚麻布 ${index}`,
      category: index % 2 === 0 ? "商品" : "护甲",
      stale: false,
      sellPrice: 100 + index,
      minPrice: 90 + index,
      sellRef: 95 + index,
      spreadPercent: index % 100,
      trendPercent: 0,
      changePercent: 0,
      quantity: index,
      numAuctions: index
    }));
    const view = { query: "亚麻", category: "商品", sortKey: "spreadPercent" as const, sortAsc: false, sortExplicit: true };
    filterSortSignals(rows, view);
    const start = process.cpuUsage();
    const filtered = filterSortSignals(rows, view);
    expect(filtered.length).toBeGreaterThan(0);
    expect(cpuMsSince(start)).toBeLessThan(50);
  });

  it("keeps a 5,000-event journal under the 4MB budget", () => {
    const events: JournalEvent[] = Array.from({ length: 5000 }, (_, index) => ({
      k: "buy", t: index, itemId: 1 + (index % 100), qty: 1, cost: 100
    }));
    const bytes = Buffer.byteLength(JSON.stringify(events), "utf8");
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });
});
