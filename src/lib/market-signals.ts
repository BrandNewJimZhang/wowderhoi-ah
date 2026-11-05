// Serves the terminal's market bundle from a per-scan-generation cache:
// the universe query, the price index, the signals and the shared
// decision core only rerun when a new scan lands, so filter/sort/page
// interactions pay one cheap timestamp probe instead of recomputing the
// whole market on every request.
//
// The phase is the exception. It is a function of wall-clock age, and a
// generation can cross a boundary without a new scan; it is therefore
// recomputed on every request, exactly like WAH.currentPhase runs in game.
import { buildMarketSignal, type MarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreOutput, OwnSales } from "@/lib/core/types";
import { buildPriceIndex, type PriceIndex } from "@/lib/deflator";
import type { MarketHistory, MarketSnapshot } from "@/lib/market-data";
import { resolveBudgetCopper, resolvePhaseOverride } from "@/lib/config";
import type { MarketPhase } from "@/lib/market-rules";
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
  // Injectable clock so the phase-boundary behaviour is testable.
  now?: () => Date;
};

type CacheEntry = {
  scopeId: string | null;
  latestAtMs: number;
  anchorAtMs: number | null;
  breadth: number;
  phase: MarketPhase;
  bundle: MarketBundle;
};

function emptyBundle(phase: MarketPhase, scope: MarketScope | null = null): MarketBundle {
  return {
    scope,
    signals: [],
    latestSnapshotAt: null,
    phase,
    priceIndex: { dates: [], values: [], baseDate: "" },
    evaluation: {
      phase,
      rows: [],
      actions: [],
      diagnostics: { excluded: {} }
    }
  };
}

function newest(snapshots: MarketSnapshot[]): MarketSnapshot {
  return snapshots.reduce((latest, snapshot) => (snapshot.timestamp > latest.timestamp ? snapshot : latest));
}

function ageHours(now: Date, firstScanAtMs: number | null): number {
  if (firstScanAtMs === null) return 0;
  return Math.max(0, (now.getTime() - firstScanAtMs) / (60 * 60 * 1000));
}

export function createMarketSignalSource(fetchers: SignalFetchers) {
  let cached: CacheEntry | null = null;
  const nowOf = fetchers.now ?? (() => new Date());

  return {
    async getMarketSignals(): Promise<MarketBundle> {
      const scope = await fetchers.getMarketScope();
      const latestSnapshotAt = await fetchers.getLatestSnapshotTime(scope);
      if (latestSnapshotAt === null) {
        cached = null;
        return emptyBundle(resolvePhaseOverride() ?? "ignition", scope);
      }
      const now = nowOf();
      const latestAtMs = latestSnapshotAt.getTime();
      if (cached !== null && cached.scopeId === (scope?.id ?? null) && cached.latestAtMs === latestAtMs) {
        const currentPhase = resolvePhaseOverride() ?? resolvePhase(ageHours(now, cached.anchorAtMs), cached.breadth);
        if (currentPhase === cached.phase) return cached.bundle;
      }

      const universe = await fetchers.getMarketUniverse(scope);
      const earliestSnapshotAt = await fetchers.getEarliestSnapshotTime(scope);
      // The addon's configured opening time beats the oldest scan: a fresh
      // terminal install (or a pruned database) must not reset the phase.
      const anchorAt = scope?.openedAt ?? earliestSnapshotAt ?? null;
      // Breadth counts the items the newest scan actually listed, matching
      // WAH.currentPhase's scan.items loop. An item that dropped out of the
      // book keeps its history but no longer counts toward market breadth.
      const breadth = universe.filter(
        (item) => item.snapshots.length > 0 && newest(item.snapshots).timestamp.getTime() === latestAtMs
      ).length;
      const phase = resolvePhaseOverride() ?? resolvePhase(ageHours(now, anchorAt?.getTime() ?? null), breadth);
      const priceIndex = buildPriceIndex(universe);
      const signals = universe
        .filter((item) => item.snapshots.length > 0)
        .map((item) => buildMarketSignal(item, now, { phase, index: priceIndex, currentAt: latestSnapshotAt }));
      const byItemId = new Map(universe.map((item) => [item.itemId, item]));
      // The addon's radar only evaluates the current scan. A stale signal
      // describes a book that is gone, so it stays in the monitor but never
      // becomes an action, a position or an alert input.
      const pairs = signals
        .filter((signal) => !signal.stale)
        .map((signal) => ({ signal, history: byItemId.get(signal.itemId) }))
        .filter((pair): pair is { signal: MarketSignal; history: MarketHistory } => pair.history !== undefined);
      const [positions, ownSales] = await Promise.all([fetchers.getPositions(scope), fetchers.getOwnSales(scope)]);
      const input = buildCoreInput(pairs, {
        now,
        phase,
        firstScanAt: earliestSnapshotAt ?? undefined,
        positions,
        ownSales,
        budgetCopper: resolveBudgetCopper(),
        // Cash is what the character actually holds at the last scan; the
        // planning budget is a separate cap. Passing the budget as cash made
        // the terminal's capital block lie about the same field the addon
        // fills from GetMoney(). An absent market leaves it undefined
        // ("unknown") rather than 0 ("broke").
        cashCopper: scope?.cash
      });
      const bundle: MarketBundle = {
        scope,
        signals,
        latestSnapshotAt,
        phase,
        priceIndex,
        evaluation: runCore(input)
      };
      cached = {
        scopeId: scope?.id ?? null,
        latestAtMs,
        anchorAtMs: anchorAt?.getTime() ?? null,
        breadth,
        phase,
        bundle
      };
      if (fetchers.recordDecisions) await fetchers.recordDecisions(bundle);
      return bundle;
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
