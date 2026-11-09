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
import { getGenerationSignals, getLatestGeneration, getMarketRevision, getPositions } from "@/lib/repositories";
import { getMarketScope, type MarketScope } from "@/lib/market-scope";

// Everything a page needs to describe the market, without its rows. The
// item and health pages used to load the whole bundle for these fields,
// which meant reading thousands of signal documents to render one item.
type MarketContext = {
  scope: MarketScope | null;
  // Opaque token for the import the page rendered from; the browser polls
  // the same token and refreshes when it moves. It is read before the
  // generation so an import landing mid-request still counts as newer.
  revision: string;
  latestScanAt: Date | null;
  // The phase right now, from wall-clock age and breadth.
  phase: MarketPhase;
  // The phase the core actually evaluated under.
  generationPhase: MarketPhase;
  priceIndex: PriceIndex;
  gapMinutes: number | null;
  staleCount: number;
  // Materialised signal rows: priced books from the scan plus carried
  // stale books. A generation stores both counts, so the total needs no
  // row read.
  signalCount: number;
  // True when the display phase moved since the scan; the dashboard must
  // hide actions that were sized under the old gates.
  phaseMismatch: boolean;
};

export type MarketBundle = MarketContext & {
  signals: MarketSignal[];
  evaluation: CoreOutput;
};

type ReaderFetchers = {
  getMarketScope: () => Promise<MarketScope | null>;
  getMarketRevision: (scope: MarketScope | null) => Promise<string>;
  getLatestGeneration: (scope: MarketScope | null) => Promise<GenerationRecord | null>;
  getSignals: (generationId: string) => Promise<StoredSignalRow[]>;
  // Injectable clock so phase-boundary behaviour is testable.
  now?: () => Date;
};

function emptyContext(phase: MarketPhase, scope: MarketScope | null, revision: string): MarketContext {
  return {
    scope,
    revision,
    latestScanAt: null,
    phase,
    generationPhase: phase,
    priceIndex: { dates: [], values: [], baseDate: "" },
    gapMinutes: null,
    staleCount: 0,
    signalCount: 0,
    phaseMismatch: false
  };
}

function emptyEvaluation(phase: MarketPhase): CoreOutput {
  return {
    phase,
    rows: [],
    opportunities: [],
    actions: [],
    diagnostics: { excluded: {}, unfunded: { kelly: 0, exposure: 0, purse: 0, depth: 0 } }
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
  // One generation per request: the scope resolution and the newest
  // generation are the same two reads for both views, and reading them
  // twice could straddle an import that lands between the calls.
  const readGeneration = async () => {
    const scope = await fetchers.getMarketScope();
    // The revision is read first: an import that commits between this read
    // and the generation read leaves the embedded revision behind the
    // polled one, so the page refreshes once more. Read the other way
    // around, such an import would be invisible until the next one.
    const revision = await fetchers.getMarketRevision(scope);
    const generation = await fetchers.getLatestGeneration(scope);
    return { scope, generation, revision };
  };
  const contextOf = (
    scope: MarketScope | null,
    generation: GenerationRecord,
    now: Date,
    revision: string
  ): MarketContext => {
    const phase = displayPhaseOf(scope, generation, now);
    return {
      scope,
      revision,
      latestScanAt: generation.scannedAt,
      phase,
      generationPhase: generation.phase,
      priceIndex: generation.priceIndex,
      gapMinutes: generation.gapMinutes,
      staleCount: generation.staleCount,
      signalCount: generation.breadth + generation.staleCount,
      phaseMismatch: phase !== generation.phase
    };
  };
  return {
    async getMarketContext(): Promise<MarketContext> {
      const { scope, generation, revision } = await readGeneration();
      if (!generation) return emptyContext(resolvePhaseOverride() ?? "ignition", scope, revision);
      return contextOf(scope, generation, nowOf(), revision);
    },
    async getMarketBundle(): Promise<MarketBundle> {
      const { scope, generation, revision } = await readGeneration();
      if (!generation) {
        const phase = resolvePhaseOverride() ?? "ignition";
        return { ...emptyContext(phase, scope, revision), signals: [], evaluation: emptyEvaluation(phase) };
      }
      const rows = await fetchers.getSignals(generation.id);
      return {
        ...contextOf(scope, generation, nowOf(), revision),
        signals: rows.map((row) => row.signal),
        evaluation: generation.core
      };
    }
  };
}

const defaultReader = createMarketReader({
  getMarketScope,
  getMarketRevision,
  getLatestGeneration,
  getSignals: getGenerationSignals
});

export const getMarketBundle = defaultReader.getMarketBundle;
export const getMarketContext = defaultReader.getMarketContext;

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
