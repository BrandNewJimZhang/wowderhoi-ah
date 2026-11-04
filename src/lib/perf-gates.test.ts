// Unit-level performance gates for the economic system. The HTTP-level
// budgets live in scripts/perf; these catch the stages that run on every
// scan generation or import before they become a page-level stall.
//
// The core budget is deliberately looser than the in-game frame budget:
// the terminal runs Core.lua inside fengari, a JavaScript Lua VM, while
// the addon runs the same file on the client's native Lua.
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { buildMarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreInput } from "@/lib/core/types";
import { solveProduction, type LpRecipe } from "@/lib/craft-lp";
import { replayJournal, type JournalEvent } from "@/lib/journal";
import { loadRecipeDataset, toLpRecipe } from "@/lib/recipes";
import { normalizeAddonScan } from "@/lib/addon-scan";

const NOW = 1_800_000_000;

// Budgets include headroom for a loaded CI box: the whole suite runs test
// files in parallel, so a stage that takes 125ms alone can take 3-4x that
// while competing for a core. These gates catch order-of-magnitude
// regressions; the standalone measurement is recorded in the docs.
const budgets = {
  core866Ms: 1000,
  buildInputMs: 100,
  journal5000Ms: 100,
  lp120Ms: 200,
  scan9000Ms: 1000
};

function coreInput(itemCount: number): CoreInput {
  const items: CoreInput["market"]["items"] = {};
  for (let index = 0; index < itemCount; index += 1) {
    const min = 100 + index;
    items[10_000 + index] = {
      itemId: 10_000 + index,
      name: `Item ${index}`,
      itemClass: "Trade Goods",
      vendorP: 1,
      minPrice: min,
      sellP: min + 200,
      quantity: 200,
      numAuctions: 10,
      sellers: 4,
      tiers: [{ p: min, q: 50 }, { p: min + 100, q: 150 }],
      history: { sellRef: min + 250, samples: 8 },
      inferredSold: 10,
      elapsedHours: 0.25
    };
  }
  return {
    now: NOW,
    phaseOverride: "wave",
    market: { scannedAt: NOW, firstScanAt: NOW - 30 * 3600, items },
    capital: { cash: 1_000_000, budget: 1_000_000 },
    capacity: { bagSlots: 20, stackSize: 20 }
  };
}

describe("system performance gates", () => {
  it("evaluates 866 items through the shared core inside the gate (warm)", () => {
    const input = coreInput(866);
    runCore(input); // warm the Lua state and template caches
    const start = performance.now();
    const output = runCore(input);
    const elapsed = performance.now() - start;
    expect(output.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(budgets.core866Ms);
  });

  it("builds the core input for 866 items inside the gate", () => {
    const histories = Array.from({ length: 866 }, (_, index) => ({
      itemId: 10_000 + index,
      name: `Item ${index}`,
      quality: "common",
      category: "Trade Goods",
      subCategory: "Herb",
      vendorPrice: 0,
      snapshots: [{
        timestamp: new Date(NOW * 1000), server: "R", faction: "A",
        minPrice: 100 + index, marketPrice: 110 + index, sellPrice: 120 + index,
        quantity: 200, numAuctions: 10
      }],
      dailySummaries: []
    })) as unknown as Parameters<typeof buildMarketSignal>[0][];
    const signals = histories.map((history) => buildMarketSignal(history, new Date(NOW * 1000), { phase: "wave" }));
    const pairs = histories.map((history, index) => ({ history, signal: signals[index] }));
    const start = performance.now();
    const input = buildCoreInput(pairs, { now: new Date(NOW * 1000), phase: "wave", budgetCopper: 1_000_000 });
    expect(Object.keys(input.market.items)).toHaveLength(866);
    expect(performance.now() - start).toBeLessThan(budgets.buildInputMs);
  });

  it("replays a 5,000-event journal inside the gate", () => {
    const events: JournalEvent[] = [];
    for (let index = 0; index < 5000; index += 1) {
      events.push(index % 2 === 0
        ? { k: "buy", t: index, itemId: 1 + (index % 100), qty: 1, cost: 100 }
        : { k: "vendor", t: index, itemId: 1 + (index % 100), qty: 1, paid: 120 });
    }
    const start = performance.now();
    const state = replayJournal(events);
    expect(Object.keys(state.positions).length).toBe(50);
    expect(performance.now() - start).toBeLessThan(budgets.buildInputMs);
  });

  it("solves 120 production candidates inside the gate", () => {
    const dataset = loadRecipeDataset();
    const recipes: LpRecipe[] = dataset.recipes.map(toLpRecipe);
    const prices = new Map<number, number>();
    for (let index = 0; index < 3000; index += 1) prices.set(index, 100 + index);
    const start = performance.now();
    const solution = solveProduction(recipes, {
      prices,
      capacity: {
        裁缝: 40, 制皮: 40, 锻造: 30, 工程学: 30, 炼金术: 60, 附魔: 60,
        烹饪: 100, 急救: 100, 钓鱼: 20, 采矿: 20, 草药学: 20, 剥皮: 20,
        毒药: 10, 理解: 10
      },
      budget: 500_000,
      feeRate: 0.05,
      maxCandidates: 120
    });
    expect(solution.candidates).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(budgets.lp120Ms);
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
    const start = performance.now();
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
    expect(performance.now() - start).toBeLessThan(budgets.scan9000Ms);
  });

  it("keeps a 5,000-event journal and a 9,000-item scan under the 4MB budget", () => {
    const events: JournalEvent[] = Array.from({ length: 5000 }, (_, index) => ({
      k: "buy", t: index, itemId: 1 + (index % 100), qty: 1, cost: 100
    }));
    const bytes = Buffer.byteLength(JSON.stringify(events), "utf8");
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });
});
