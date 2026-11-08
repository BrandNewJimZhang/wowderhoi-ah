// The read side of the market: one generation, its materialised signals and
// the core output that was computed when the scan landed. Nothing here runs
// the core or writes a decision. The display phase is the one exception to
// "read what was stored": age crosses a phase boundary without a new scan,
// exactly as WAH.currentPhase does in game, so the current phase is
// recomputed per request. When it differs from the generation's phase the
// UI must not apply the new gates to the old book.
import type { MarketSignal } from "@/lib/analytics";
import type { CoreOutput } from "@/lib/core/types";
import type { PriceIndex } from "@/lib/deflator";
import type { GenerationRecord } from "@/lib/generation-record";
import { resolvePhaseOverride } from "@/lib/config";
import { describeFreshness } from "@/lib/freshness";
import { ageHours, resolvePhase } from "@/lib/phase";
import type { MarketPhase } from "@/lib/market-rules";
import type { StoredSignalRow } from "@/lib/signal-row";
import { getGenerationSignals, getLatestGeneration, getPositions } from "@/lib/repositories";
import { getMarketScope, type MarketScope } from "@/lib/market-scope";

export type MarketBundle = {
  scope: MarketScope | null;
  signals: MarketSignal[];
  latestScanAt: Date | null;
  // The phase right now, from wall-clock age and breadth.
  phase: MarketPhase;
  // The phase the core actually evaluated under.
  generationPhase: MarketPhase;
  priceIndex: PriceIndex;
  evaluation: CoreOutput;
  gapMinutes: number | null;
  staleCount: number;
  // True when the display phase moved since the scan; the dashboard must
  // hide actions that were sized under the old gates.
  phaseMismatch: boolean;
};

type ReaderFetchers = {
  getMarketScope: () => Promise<MarketScope | null>;
  getLatestGeneration: (scope: MarketScope | null) => Promise<GenerationRecord | null>;
  getSignals: (generationId: string) => Promise<StoredSignalRow[]>;
  // Injectable clock so phase-boundary behaviour is testable.
  now?: () => Date;
};

function emptyBundle(phase: MarketPhase, scope: MarketScope | null = null): MarketBundle {
  return {
    scope,
    signals: [],
    latestScanAt: null,
    phase,
    generationPhase: phase,
    priceIndex: { dates: [], values: [], baseDate: "" },
    evaluation: {
      phase,
      rows: [],
      opportunities: [],
      actions: [],
      diagnostics: { excluded: {}, unfunded: { kelly: 0, exposure: 0, purse: 0, depth: 0 } }
    },
    gapMinutes: null,
    staleCount: 0,
    phaseMismatch: false
  };
}

// The configured opening time beats the persisted first observation, which
// beats the generation's own anchor: a pruned store must not reset a mature
// market to ignition. One resolver keeps the bundle and the shell badges
// from reading different phases.
function displayPhaseOf(
  scope: MarketScope | null,
  generation: GenerationRecord | null,
  now: Date
): MarketPhase {
  const override = resolvePhaseOverride();
  if (override) return override;
  if (!generation) return "ignition";
  const anchor = scope?.openedAt ?? scope?.firstScanAt ?? generation.firstScanAt;
  return resolvePhase(ageHours(now, anchor), generation.breadth);
}

export function createMarketReader(fetchers: ReaderFetchers) {
  const nowOf = fetchers.now ?? (() => new Date());
  return {
    async getMarketBundle(): Promise<MarketBundle> {
      const scope = await fetchers.getMarketScope();
      const generation = await fetchers.getLatestGeneration(scope);
      if (!generation) {
        return emptyBundle(resolvePhaseOverride() ?? "ignition", scope);
      }
      const rows = await fetchers.getSignals(generation.id);
      const phase = displayPhaseOf(scope, generation, nowOf());
      return {
        scope,
        signals: rows.map((row) => row.signal),
        latestScanAt: generation.scannedAt,
        phase,
        generationPhase: generation.phase,
        priceIndex: generation.priceIndex,
        evaluation: generation.core,
        gapMinutes: generation.gapMinutes,
        staleCount: generation.staleCount,
        phaseMismatch: phase !== generation.phase
      };
    }
  };
}

const defaultReader = createMarketReader({
  getMarketScope,
  getLatestGeneration,
  getSignals: getGenerationSignals
});

export const getMarketBundle = defaultReader.getMarketBundle;

type NavBadges = { actions: number; stale: number; positions: number };

// The badge must agree with the dashboard: a stale scan or a moved phase
// hides the action list there, so the shell cannot advertise actions the
// page refuses to show.
export function badgeCounts(
  generation: GenerationRecord | null,
  phase: MarketPhase,
  stale: boolean,
  positionCount: number
): NavBadges {
  const actionable = generation !== null && !stale && phase === generation.phase;
  return {
    actions: actionable ? generation.core.actions.length : 0,
    stale: generation?.staleCount ?? 0,
    positions: positionCount
  };
}

// The shell renders these on every page; they are two cheap reads plus one
// count, not the full signal bundle.
export async function getNavigationBadges(): Promise<NavBadges> {
  const scope = await getMarketScope();
  if (!scope) return { actions: 0, stale: 0, positions: 0 };
  const now = new Date();
  const [generation, positions] = await Promise.all([
    getLatestGeneration(scope),
    getPositions(scope)
  ]);
  const stale = describeFreshness(generation?.scannedAt ?? null, now).stale;
  return badgeCounts(generation, displayPhaseOf(scope, generation, now), stale, Object.keys(positions).length);
}
