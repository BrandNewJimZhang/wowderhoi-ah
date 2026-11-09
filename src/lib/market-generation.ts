// One scan becomes one immutable generation: the current book (quotes), the
// signals derived from the book plus the series, the shared core's output,
// and the decisions that output named. Everything expensive happens here,
// outside the write transaction; page reads only decode what this module
// produced.
import type { AddonScan } from "@/lib/addon-scan";
import { buildMarketSignal } from "@/lib/analytics";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreOutput, OwnSales } from "@/lib/core/types";
import { decisionIdFor } from "@/lib/decision-id";
import { buildPriceIndex, type PriceIndex } from "@/lib/deflator";
import {
  mergeSeriesByItem,
  scanSeriesPoints,
  type AddonSeries,
  type SeriesPoint
} from "@/lib/item-series";
import type { MarketQuote, SignalItem } from "@/lib/market-data";
import { ageHours, resolvePhase } from "@/lib/phase";
import type { MarketPhase } from "@/lib/market-rules";
import { SIGNAL_SCHEMA_VERSION, type StoredSignalRow } from "@/lib/signal-row";

type QuoteRow = MarketQuote;

export type SeriesRow = {
  itemId: number;
  firstAt: Date;
  lastAt: Date;
  pointCount: number;
  points: SeriesPoint[];
};

export type DecisionRow = {
  decisionId: string;
  itemId: number | null;
  kind: string;
  reason: string | null;
  expectedNet: number | null;
  fillProb: number | null;
  fillBasis: string | null;
  allocQty: number | null;
  allocUnitPrice: number | null;
};

export type GenerationPlan = {
  scannedAt: Date;
  // Character whose scan produced the observation. The generation is
  // market-scoped; the private state it pairs with is character-scoped.
  // Optional for fixtures written before the field existed.
  character?: string;
  phase: MarketPhase;
  breadth: number;
  staleCount: number;
  firstScanAt: Date;
  priceIndex: PriceIndex;
  core: CoreOutput;
  gapMinutes: number | null;
  quotes: Array<{ itemId: number; quote: QuoteRow }>;
  signals: Array<{ itemId: number; data: StoredSignalRow }>;
  series: SeriesRow[];
  decisions: DecisionRow[];
  seriesPointCount: number;
};

export type GenerationInput = {
  scan: AddonScan;
  series: AddonSeries | null;
  // Static facts for every item either the scan or the previous generation
  // references. A missing row is a programming error, not a soft skip.
  items: Map<number, SignalItem>;
  existingSeries: Array<{ itemId: number; points: readonly SeriesPoint[] }>;
  // The previous generation's current book. An item the scan no longer
  // prices is carried forward (its signal is stale and never reaches the
  // core) until a later scan lists it again, so the market table can still
  // explain where its history ends.
  previous: { scannedAt: Date; quotes: Array<{ item: SignalItem; quote: MarketQuote }> } | null;
  openedAt: Date | null;
  firstScanAt: Date | null;
  positions: Record<number, { qty: number; cost: number }>;
  ownSales: OwnSales;
  budgetCopper: number;
  phaseOverride: MarketPhase | null;
};

// The stored shape of a merged series. The live import, its duplicate
// path and the migration all write this table, so they build the rows in
// one place instead of three hand-copied maps.
// The stored signal rows carry the core's per-item projection so the item
// page can read one row instead of searching the evaluation. A journal-only
// replay recomputes the core in place; its projections must be rebuilt with
// it, or the page would keep a fill estimate sized for the previous ledger.
export function withCoreRows(
  rows: readonly StoredSignalRow[],
  core: CoreOutput
): StoredSignalRow[] {
  const byItem = new Map(core.rows.map((row) => [row.itemId, row]));
  return rows.map((row) => ({ ...row, coreRow: byItem.get(row.signal.itemId) ?? null }));
}

export function seriesRowsFrom(merged: ReadonlyMap<number, readonly SeriesPoint[]>): SeriesRow[] {
  return Array.from(merged.entries())
    .sort(([left], [right]) => left - right)
    .map(([itemId, points]) => ({
      itemId,
      firstAt: new Date(points[0].t * 1000),
      lastAt: new Date(points[points.length - 1].t * 1000),
      pointCount: points.length,
      points: [...points]
    }));
}

function quoteFromScanItem(item: AddonScan["items"][number], scannedAt: Date, observationVersion: number | null): MarketQuote {
  return {
    timestamp: scannedAt,
    priced: item.priced,
    minPrice: item.minPrice,
    marketPrice: item.marketPrice,
    sellPrice: item.sellPrice,
    p5Price: item.p5Price,
    quantity: item.quantity,
    numAuctions: item.numAuctions,
    sellerCount: item.sellerCount,
    sellersInvisible: item.sellersInvisible,
    ownerVisible: item.ownerVisible,
    observationVersion,
    sellerHHI: item.sellerHHI,
    topSellerShare: item.topSellerShare,
    marketType: item.marketType,
    bidOnlyCount: item.bidOnlyCount,
    highestBid: item.highestBid,
    soldProxyLow: item.inferredSoldLow,
    soldProxyHigh: item.inferredSoldHigh,
    flowObserved: item.flowObserved,
    supplyGrowth: item.supplyGrowth,
    historySamples: item.historySamples,
    historySpanHours: item.historySpanHours,
    tierTruncated: item.tierTruncated,
    topTiers: item.tiers,
    expiring: item.expiring
  };
}

function signalItemOf(itemId: number, items: Map<number, SignalItem>): SignalItem {
  const item = items.get(itemId);
  if (!item) throw new Error(`Generation references item ${itemId} without a catalogue row`);
  return item;
}

type DecisionIdentity = { realm: string; faction: string; scannedAt: Date };

// The core's actions are the only source of decisions, and the import writes
// them from two paths: a fresh scan and the journal-only replay of an
// existing generation. Both must name and size them identically, or a
// replayed scan would attribute a sale to an identity the first import
// never wrote.
export function decisionRowsFrom(core: CoreOutput, identity: DecisionIdentity): DecisionRow[] {
  const rows: DecisionRow[] = [];
  const seen = new Set<string>();
  for (const action of core.actions) {
    const decisionId = decisionIdFor({
      realm: identity.realm,
      faction: identity.faction,
      scannedAt: identity.scannedAt,
      itemId: action.itemId,
      kind: action.kind
    });
    // The core emits at most one action per item and kind; a duplicate id
    // would mean two recommendations share an identity, which the review
    // could not attribute. Fail loudly instead of silently keeping one.
    if (seen.has(decisionId)) {
      throw new Error(`Duplicate decision identity ${decisionId}`);
    }
    seen.add(decisionId);
    rows.push({
      decisionId,
      itemId: action.itemId,
      kind: action.kind,
      reason: action.reason,
      expectedNet: action.expectedNet,
      fillProb: action.kind === "buy" ? action.fillProb : null,
      fillBasis: action.kind === "buy" ? action.fillBasis : null,
      allocQty: action.kind === "buy" ? action.allocQty : action.qty,
      allocUnitPrice: action.kind === "buy" ? action.allocUnitPrice : action.price
    });
  }
  return rows;
}

function previousPointSeconds(points: readonly SeriesPoint[], scanSeconds: number): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].t < scanSeconds) return points[index].t;
  }
  return null;
}

export function buildGenerationPlan(input: GenerationInput): GenerationPlan {
  const { scan } = input;
  const scanSeconds = Math.round(scan.scannedAt.getTime() / 1000);
  const seriesFirst = input.series?.firstScanAt ? new Date(input.series.firstScanAt * 1000) : null;
  const firstScanAt = [input.firstScanAt, seriesFirst, scan.scannedAt]
    .filter((value): value is Date => value instanceof Date)
    .reduce((earliest, value) => (value < earliest ? value : earliest));
  const phaseAnchor = input.openedAt ?? firstScanAt;
  const breadth = scan.items.filter((item) => item.priced).length;
  const phase = input.phaseOverride ?? resolvePhase(ageHours(scan.scannedAt, phaseAnchor), breadth);

  // The addon series is global; the current scan contributes one more point
  // per priced item. Only a priced row replaces the item's current book: a
  // demand-only row leaves the last priced book to be carried as stale. A
  // carried quote must itself be priced -- a bid-only row has no price to
  // describe, and materialising it would print a zero sell front the market
  // never observed.
  const currentIds = new Set(scan.items.filter((item) => item.priced).map((item) => item.itemId));
  const staleCandidates = (input.previous?.quotes ?? []).filter(
    (row) => row.quote.priced && !currentIds.has(row.item.itemId)
  );
  const incomingPoints = [...(input.series?.points ?? []), ...scanSeriesPoints(scan)];
  const merged = mergeSeriesByItem(input.existingSeries, incomingPoints, scanSeconds);

  const priceIndex = buildPriceIndex(
    Array.from(merged.entries()).map(([itemId, points]) => ({ itemId, points }))
  );
  // The scan's own point sits at scannedAt; elapsedHours is the distance to
  // the point before it, so the lookup is strictly earlier.
  const previousAtById = new Map<number, number | null>();
  for (const [itemId, points] of merged) {
    previousAtById.set(itemId, previousPointSeconds(points, scanSeconds));
  }

  const quoteById = new Map<number, MarketQuote>();
  for (const item of scan.items) {
    quoteById.set(item.itemId, quoteFromScanItem(item, scan.scannedAt, scan.observationVersion));
  }

  const signals: Array<{ itemId: number; data: StoredSignalRow }> = [];
  for (const item of scan.items) {
    if (!item.priced) continue;
    const quote = quoteById.get(item.itemId)!;
    const signal = buildMarketSignal(
      { item: signalItemOf(item.itemId, input.items), quote, series: merged.get(item.itemId) ?? [] },
      scan.scannedAt,
      { phase, index: priceIndex, currentAt: scan.scannedAt }
    );
    signals.push({
      itemId: item.itemId,
      data: {
        schemaVersion: SIGNAL_SCHEMA_VERSION,
        signal,
        coreRow: null,
        previousAt: previousAtById.get(item.itemId) ?? null
      }
    });
  }
  for (const row of staleCandidates) {
    const signal = buildMarketSignal(
      { item: row.item, quote: row.quote, series: merged.get(row.item.itemId) ?? [] },
      scan.scannedAt,
      { phase, index: priceIndex, currentAt: scan.scannedAt }
    );
    signals.push({
      itemId: row.item.itemId,
      data: {
        schemaVersion: SIGNAL_SCHEMA_VERSION,
        signal,
        coreRow: null,
        previousAt: previousAtById.get(row.item.itemId) ?? null
      }
    });
  }
  signals.sort((left, right) => left.itemId - right.itemId);

  const corePairs = signals
    .filter((row) => !row.data.signal.stale)
    .map((row) => {
      const quote = quoteById.get(row.itemId)!;
      const previous = previousAtById.get(row.itemId) ?? null;
      return { signal: row.data.signal, quote, previousAt: previous === null ? null : new Date(previous * 1000) };
    });
  const core = runCore(buildCoreInput(corePairs, {
    now: scan.scannedAt,
    phase,
    firstScanAt,
    positions: input.positions,
    ownSales: input.ownSales,
    budgetCopper: input.budgetCopper,
    cashCopper: scan.cash,
    bagSlots: scan.bagSlots ?? undefined
  }));
  const coreByItem = new Map(core.rows.map((row) => [row.itemId, row]));
  for (const row of signals) {
    row.data.coreRow = coreByItem.get(row.itemId) ?? null;
  }

  const decisions = decisionRowsFrom(core, {
    realm: scan.server,
    faction: scan.faction,
    scannedAt: scan.scannedAt
  });

  const series = seriesRowsFrom(merged);

  return {
    scannedAt: scan.scannedAt,
    character: scan.character ?? "",
    phase,
    breadth,
    staleCount: staleCandidates.length,
    firstScanAt,
    priceIndex,
    core,
    gapMinutes: input.previous
      ? Math.max(0, Math.round((scan.scannedAt.getTime() - input.previous.scannedAt.getTime()) / 60_000))
      : null,
    quotes: Array.from(quoteById.entries()).map(([itemId, quote]) => ({ itemId, quote })),
    signals,
    series,
    decisions,
    seriesPointCount: series.reduce((sum, row) => sum + row.pointCount, 0)
  };
}
