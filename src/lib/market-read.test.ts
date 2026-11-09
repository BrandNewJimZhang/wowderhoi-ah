import { describe, expect, it } from "vitest";
import type { GenerationRecord } from "@/lib/generation-record";
import type { MarketSignal } from "@/lib/analytics";
import type { StoredSignalRow } from "@/lib/signal-row";
import { signalFixture } from "@/lib/signal-fixture";
import { badgeCounts, createMarketReader, type MarketBundle } from "@/lib/market-read";

const LATEST = new Date("2026-07-20T10:00:00Z");

function signal(itemId: number, sellPrice: number, stale = false): MarketSignal {
  return signalFixture({
    itemId,
    iconId: 100,
    sellPrice,
    minPrice: Math.round(sellPrice * 0.5),
    quantity: 200,
    numAuctions: 10,
    sellerCount: 4,
    ownerVisible: true,
    marketType: "commodity",
    stale,
    sellSamples: 3,
    historySamples: 3,
    historySpanHours: 2,
    spreadPercent: 50
  });
}

function generation(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: "g1",
    marketId: "m1",
    scannedAt: LATEST,
    phase: "ignition",
    breadth: 1,
    staleCount: 1,
    firstScanAt: new Date(LATEST.getTime() - 200 * 3600 * 1000),
    priceIndex: { dates: [], values: [], baseDate: "" },
    core: {
      phase: "ignition",
      rows: [],
      opportunities: [],
      actions: [],
      diagnostics: { excluded: {}, unfunded: { kelly: 0, exposure: 0, purse: 0, depth: 0 } }
    },
    gapMinutes: 15,
    ...overrides
  };
}

function row(signalValue: MarketSignal): StoredSignalRow {
  return { schemaVersion: 1, signal: signalValue, coreRow: null, previousAt: null };
}

function reader(options: {
  scope?: Record<string, unknown> | null;
  record?: GenerationRecord | null;
  signals?: StoredSignalRow[];
  now?: Date;
} = {}) {
  return createMarketReader({
    getMarketScope: async () => (options.scope === null ? null : {
      id: "m1", realm: "TestRealm", faction: "Alliance", cash: 500000, character: "Tester",
      ...(options.scope ?? {})
    }),
    getMarketRevision: async (scope) => scope ? `${scope.id}:rev-1` : "none",
    getLatestGeneration: async () => options.record === undefined ? generation() : options.record,
    getSignals: async () => options.signals ?? [row(signal(1, 200))],
    now: () => options.now ?? LATEST
  });
}

describe("badgeCounts", () => {
  const action = {
    kind: "sell", itemId: 1, qty: 1, price: 100, expectedNet: 10, netPerMinute: 1, reason: "test"
  } as const;

  it("counts the stored actions only while the generation is still actionable", () => {
    const record = generation({ phase: "ignition", core: { ...generation().core, actions: [action] } });
    expect(badgeCounts(record, "ignition", false, 3)).toEqual({ actions: 1, stale: 1, positions: 3 });
  });

  it("hides actions once the display phase moved past the scan", () => {
    const record = generation({ phase: "ignition", core: { ...generation().core, actions: [action] } });
    expect(badgeCounts(record, "steady", false, 0).actions).toBe(0);
  });

  it("hides actions once the scan is stale", () => {
    const record = generation({ phase: "ignition", core: { ...generation().core, actions: [action] } });
    expect(badgeCounts(record, "ignition", true, 0).actions).toBe(0);
  });
});

describe("getMarketContext", () => {
  it("serves the generation's metadata without loading its signal rows", async () => {
    let signalCalls = 0;
    const source = createMarketReader({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0, character: "Tester" }),
      getMarketRevision: async () => "m1:rev-1",
      getLatestGeneration: async () => generation(),
      getSignals: async () => {
        signalCalls += 1;
        return [];
      },
      now: () => LATEST
    });
    const context = await source.getMarketContext();
    expect(context.scope?.id).toBe("m1");
    expect(context.latestScanAt?.toISOString()).toBe(LATEST.toISOString());
    // The health page prints the row count; it must come from the stored
    // breadth and stale count, not from a 4,000-row read.
    expect(context.signalCount).toBe(2);
    expect(signalCalls).toBe(0);
  });

  it("reads the data revision before the generation so a mid-request import still refreshes", async () => {
    const order: string[] = [];
    const source = createMarketReader({
      getMarketScope: async () => ({ id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0, character: "Tester" }),
      getMarketRevision: async () => {
        order.push("revision");
        return "m1:run-1";
      },
      getLatestGeneration: async () => {
        order.push("generation");
        return generation();
      },
      getSignals: async () => [],
      now: () => LATEST
    });
    const context = await source.getMarketContext();
    // An import that commits between the two reads must leave the embedded
    // revision behind the polled one; the page then refreshes once more
    // instead of hiding the new scan until the next import.
    expect(order).toEqual(["revision", "generation"]);
    expect(context.revision).toBe("m1:run-1");
  });

  it("returns an empty context before the first generation", async () => {
    const context = await reader({ record: null }).getMarketContext();
    expect(context.scope?.id).toBe("m1");
    expect(context.latestScanAt).toBeNull();
    expect(context.signalCount).toBe(0);
    expect(context.phase).toBe("ignition");
    expect(context.revision).toBe("m1:rev-1");
  });

});

describe("getMarketBundle", () => {
  it("returns an empty ignition bundle before the first generation", async () => {
    const bundle = await reader({ record: null }).getMarketBundle();
    expect(bundle.signals).toEqual([]);
    expect(bundle.latestScanAt).toBeNull();
    expect(bundle.phase).toBe("ignition");
    expect(bundle.phaseMismatch).toBe(false);
    expect(bundle.revision).toBe("m1:rev-1");
  });

  it("serves the stored signals and core without rerunning the core", async () => {
    const bundle: MarketBundle = await reader({ signals: [row(signal(1, 200)), row(signal(2, 300, true))] }).getMarketBundle();
    expect(bundle.signals.map((entry) => entry.itemId)).toEqual([1, 2]);
    expect(bundle.signals[1].stale).toBe(true);
    expect(bundle.latestScanAt?.toISOString()).toBe(LATEST.toISOString());
    expect(bundle.staleCount).toBe(1);
    expect(bundle.gapMinutes).toBe(15);
  });

  it("recomputes the display phase from wall-clock age and marks the mismatch", async () => {
    const record = generation({ breadth: 900 });
    const bundle = await reader({ record, now: LATEST }).getMarketBundle();
    // The scan was anchored 200 hours before it was taken: the generation
    // evaluated under ignition, but the market is now steady.
    expect(bundle.generationPhase).toBe("ignition");
    expect(bundle.phase).toBe("steady");
    expect(bundle.phaseMismatch).toBe(true);
  });

  it("anchors the display phase on the scope before the generation's own anchor", async () => {
    const record = generation({ breadth: 900, firstScanAt: LATEST });
    const bundle = await reader({
      record,
      now: LATEST,
      scope: { openedAt: new Date(LATEST.getTime() - 200 * 3600 * 1000) }
    }).getMarketBundle();
    expect(bundle.phase).toBe("steady");
  });

  it("never serves one market's generation to another scope", async () => {
    const seen: string[] = [];
    const source = createMarketReader({
      getMarketScope: async () => ({ id: "m2", realm: "Other", faction: "Horde", cash: 0, character: "" }),
      getMarketRevision: async (scope) => scope?.id ?? "none",
      getLatestGeneration: async (scope) => { seen.push(scope?.id ?? "none"); return null; },
      getSignals: async () => [],
      now: () => LATEST
    });
    await source.getMarketBundle();
    expect(seen).toEqual(["m2"]);
  });
});
