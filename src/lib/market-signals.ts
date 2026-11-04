// Serves the terminal's market bundle from a per-scan-generation cache:
// the universe query, the price index, the signals and the shared
// decision core only rerun when a new scan lands, so filter/sort/page
// interactions pay one cheap timestamp probe instead of recomputing the
// whole market on every request.
import { buildMarketSignal, type MarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreOutput } from "@/lib/core/types";
import { buildPriceIndex, type PriceIndex } from "@/lib/deflator";
import type { MarketHistory } from "@/lib/market-data";
import { marketPhases, type MarketPhase } from "@/lib/market-rules";
import { resolvePhase } from "@/lib/phase";
import { getEarliestSnapshotTime, getLatestSnapshotTime, getMarketUniverse, getPositions } from "@/lib/repositories";

export type MarketBundle = {
  signals: MarketSignal[];
  latestSnapshotAt: Date | null;
  phase: MarketPhase;
  priceIndex: PriceIndex;
  evaluation: CoreOutput;
};

type SignalFetchers = {
  getLatestSnapshotTime: () => Promise<Date | null>;
  getEarliestSnapshotTime: () => Promise<Date | null>;
  getMarketUniverse: () => Promise<MarketHistory[]>;
  getPositions: () => Promise<Record<number, { qty: number; cost: number }>>;
  recordDecisions?: (bundle: MarketBundle) => Promise<void>;
};

function configuredPhase(): MarketPhase | null {
  const value = process.env.AQT_PHASE;
  return value && (marketPhases as readonly string[]).includes(value) ? (value as MarketPhase) : null;
}

function configuredBudget(): number {
  const value = Number(process.env.AQT_BUDGET_COPPER);
  return Number.isFinite(value) && value > 0 ? value : 1_000_000;
}

function emptyBundle(phase: MarketPhase): MarketBundle {
  return {
    signals: [],
    latestSnapshotAt: null,
    phase,
    priceIndex: { dates: [], values: [], baseDate: "" },
    evaluation: {
      phase,
      ageHours: 0,
      breadth: 0,
      dataAgeMinutes: 0,
      rows: [],
      actions: [],
      diagnostics: { considered: 0, matched: 0, excluded: {} }
    }
  };
}

export function createMarketSignalSource(fetchers: SignalFetchers) {
  let cachedAtMs: number | null = null;
  let cached: MarketBundle = emptyBundle("ignition");

  return {
    async getMarketSignals(): Promise<MarketBundle> {
      const latestSnapshotAt = await fetchers.getLatestSnapshotTime();
      if (latestSnapshotAt === null) {
        cached = emptyBundle(configuredPhase() ?? "ignition");
        cachedAtMs = null;
        return cached;
      }
      if (cachedAtMs === latestSnapshotAt.getTime()) return cached;

      const universe = await fetchers.getMarketUniverse();
      const earliestSnapshotAt = await fetchers.getEarliestSnapshotTime();
      const priced = universe.filter((item) => item.snapshots.length > 0);
      const now = new Date();
      const ageHours = earliestSnapshotAt
        ? Math.max(0, (now.getTime() - earliestSnapshotAt.getTime()) / (60 * 60 * 1000))
        : 0;
      const phase = configuredPhase() ?? resolvePhase(ageHours, priced.length);
      const priceIndex = buildPriceIndex(universe);
      const signals = priced.map((item) => buildMarketSignal(item, now, { phase, index: priceIndex }));
      const byItemId = new Map(universe.map((item) => [item.itemId, item]));
      const pairs = signals
        .map((signal) => ({ signal, history: byItemId.get(signal.itemId) }))
        .filter((pair): pair is { signal: MarketSignal; history: MarketHistory } => pair.history !== undefined);
      const positions = await fetchers.getPositions();
      const input = buildCoreInput(pairs, {
        now,
        phase,
        positions,
        budgetCopper: configuredBudget()
      });
      cached = {
        signals,
        latestSnapshotAt,
        phase,
        priceIndex,
        evaluation: runCore(input)
      };
      cachedAtMs = latestSnapshotAt.getTime();
      if (fetchers.recordDecisions) await fetchers.recordDecisions(cached);
      return cached;
    }
  };
}

const defaultSource = createMarketSignalSource({
  getLatestSnapshotTime,
  getEarliestSnapshotTime,
  getMarketUniverse,
  getPositions,
  recordDecisions: (bundle) => import("@/lib/decisions").then((module) => module.recordDecisions(bundle))
});

export const getMarketSignals = defaultSource.getMarketSignals;
