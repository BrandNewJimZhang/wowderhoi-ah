// Serves the terminal's market bundle from a per-scan-generation cache:
// the universe query, the price index, the signals and the shared
// decision core only rerun when a new scan lands, so filter/sort/page
// interactions pay one cheap timestamp probe instead of recomputing the
// whole market on every request.
import { buildMarketSignal, type MarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreOutput, OwnSales } from "@/lib/core/types";
import { buildPriceIndex, type PriceIndex } from "@/lib/deflator";
import type { MarketHistory } from "@/lib/market-data";
import { DEFAULT_BUDGET_COPPER, marketPhases, type MarketPhase } from "@/lib/market-rules";
import { resolvePhase } from "@/lib/phase";
import { getEarliestSnapshotTime, getLatestSnapshotTime, getMarketUniverse, getOwnSales, getPositions } from "@/lib/repositories";
import { getMarketScope, type MarketScope } from "@/lib/market-scope";

export type MarketBundle = {
  scope: MarketScope | null;
  signals: MarketSignal[];
  latestSnapshotAt: Date | null;
  phase: MarketPhase;
  priceIndex: PriceIndex;
  evaluation: CoreOutput;
};

type SignalFetchers = {
  getMarketScope: () => Promise<MarketScope | null>;
  getLatestSnapshotTime: (scope: MarketScope | null) => Promise<Date | null>;
  getEarliestSnapshotTime: (scope: MarketScope | null) => Promise<Date | null>;
  getMarketUniverse: (scope: MarketScope | null) => Promise<MarketHistory[]>;
  getPositions: (scope: MarketScope | null) => Promise<Record<number, { qty: number; cost: number }>>;
  getOwnSales: (scope: MarketScope | null) => Promise<OwnSales>;
  recordDecisions?: (bundle: MarketBundle) => Promise<void>;
};

function configuredPhase(): MarketPhase | null {
  const value = process.env.AQT_PHASE;
  return value && (marketPhases as readonly string[]).includes(value) ? (value as MarketPhase) : null;
}

function configuredBudget(): number {
  const value = Number(process.env.AQT_BUDGET_COPPER);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUDGET_COPPER;
}

function emptyBundle(phase: MarketPhase, scope: MarketScope | null = null): MarketBundle {
  return {
    scope,
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
      const scope = await fetchers.getMarketScope();
      const latestSnapshotAt = await fetchers.getLatestSnapshotTime(scope);
      if (latestSnapshotAt === null) {
        cached = emptyBundle(configuredPhase() ?? "ignition", scope);
        cachedAtMs = null;
        return cached;
      }
      if (cachedAtMs === latestSnapshotAt.getTime()) return cached;

      const universe = await fetchers.getMarketUniverse(scope);
      const earliestSnapshotAt = await fetchers.getEarliestSnapshotTime(scope);
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
      const [positions, ownSales] = await Promise.all([fetchers.getPositions(scope), fetchers.getOwnSales(scope)]);
      const input = buildCoreInput(pairs, {
        now,
        phase,
        firstScanAt: earliestSnapshotAt ?? undefined,
        positions,
        ownSales,
        budgetCopper: configuredBudget()
      });
      cached = {
        scope,
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
  getMarketScope,
  getLatestSnapshotTime,
  getEarliestSnapshotTime,
  getMarketUniverse,
  getPositions,
  getOwnSales,
  recordDecisions: (bundle) => import("@/lib/decisions").then((module) => module.recordDecisions(bundle))
});

export const getMarketSignals = defaultSource.getMarketSignals;
