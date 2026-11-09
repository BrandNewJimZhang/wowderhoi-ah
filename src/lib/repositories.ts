import { prisma } from "@/lib/prisma";
import { planEstateRevision, planMatchesScan } from "@/lib/plan-view";
import type { MarketQuote } from "@/lib/market-data";
import { arraysToSeries, type SeriesPoint } from "@/lib/item-series";
import { decodeGeneration, type GenerationRecord } from "@/lib/generation-record";
import { decodeSignalRow, type StoredSignalRow } from "@/lib/signal-row";
import { ownSalesFromRows } from "@/lib/own-sales";
import type { CorePosition, OwnSales } from "@/lib/core/types";
import { fillRules } from "@/lib/market-rules";
import { CATALOG_SOURCE, SCAN_SOURCE } from "@/lib/item-catalog";
import type { MarketScope } from "@/lib/market-scope";

export const GENERATION_SELECT = {
  id: true, marketId: true, scannedAt: true, phase: true, breadth: true, staleCount: true,
  firstScanAt: true, priceIndex: true, core: true, gapMinutes: true
} as const;

type QuoteRow = {
  itemId: number;
  priced: boolean;
  minPrice: number;
  marketPrice: number;
  sellPrice: number;
  p5Price: number;
  quantity: number;
  numAuctions: number;
  sellerCount: number;
  sellersInvisible: boolean;
  ownerVisible: boolean;
  observationVersion: number | null;
  sellerHHI: number | null;
  topSellerShare: number | null;
  marketType: string | null;
  bidOnlyCount: number;
  highestBid: number;
  soldProxyLow: number;
  soldProxyHigh: number;
  flowObserved: boolean;
  supplyGrowth: number;
  historySamples: number | null;
  historySpanHours: number | null;
  tierTruncated: boolean;
  topTiers: unknown;
  expiring: unknown;
};

function toQuote(row: QuoteRow, timestamp: Date): MarketQuote {
  return { ...row, timestamp };
}

export async function getLatestGeneration(scope: MarketScope | null): Promise<GenerationRecord | null> {
  const row = await prisma.marketGeneration.findFirst({
    where: scope ? { marketId: scope.id } : {},
    orderBy: { scannedAt: "desc" },
    select: GENERATION_SELECT
  });
  return row ? decodeGeneration(row) : null;
}

export async function getGenerationSignals(generationId: string): Promise<StoredSignalRow[]> {
  const rows = await prisma.marketSignalRow.findMany({
    where: { generationId },
    select: { data: true },
    orderBy: { itemId: "asc" }
  });
  return rows.map((row) => decodeSignalRow(row.data));
}

export async function getGenerationQuotes(generationId: string): Promise<Array<{ itemId: number; quote: MarketQuote }>> {
  const generation = await prisma.marketGeneration.findUnique({
    where: { id: generationId },
    select: { scannedAt: true }
  });
  if (!generation) throw new Error(`Generation ${generationId} does not exist`);
  const rows = await prisma.marketQuote.findMany({ where: { generationId } });
  return rows.map((row) => ({ itemId: row.itemId, quote: toQuote(row, generation.scannedAt) }));
}

// SQLite binds one parameter per id; 500 keeps a batch well inside the
// driver's budget without making one query per item.
const ID_CHUNK = 500;

export async function getSeriesForItems(
  marketId: string,
  itemIds: readonly number[]
): Promise<Array<{ itemId: number; points: SeriesPoint[] }>> {
  const out: Array<{ itemId: number; points: SeriesPoint[] }> = [];
  const ids = Array.from(new Set(itemIds));
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const rows = await prisma.itemSeries.findMany({
      where: { marketId, itemId: { in: chunk } },
      select: { itemId: true, points: true }
    });
    for (const row of rows) out.push({ itemId: row.itemId, points: arraysToSeries(row.points) });
  }
  return out;
}

async function latestQuoteForItem(itemId: number, marketId: string | undefined) {
  const row = await prisma.marketQuote.findFirst({
    where: { itemId, ...(marketId ? { marketId } : {}) },
    orderBy: { generation: { scannedAt: "desc" } },
    include: { generation: { select: { scannedAt: true } } }
  });
  return row ? { generationId: row.generationId, quote: toQuote(row, row.generation.scannedAt) } : null;
}

async function demandQuoteForItem(itemId: number, marketId: string | undefined) {
  const row = await prisma.marketQuote.findFirst({
    where: { itemId, bidOnlyCount: { gt: 0 }, ...(marketId ? { marketId } : {}) },
    orderBy: { generation: { scannedAt: "desc" } },
    include: { generation: { select: { scannedAt: true } } }
  });
  return row ? toQuote(row, row.generation.scannedAt) : null;
}

export async function getItemDetail(itemId: number, scope: MarketScope | null) {
  const marketId = scope?.id;
  const [item, quoteRow, demandQuote, seriesRow] = await Promise.all([
    prisma.item.findUnique({ where: { itemId } }),
    latestQuoteForItem(itemId, marketId),
    demandQuoteForItem(itemId, marketId),
    marketId
      ? prisma.itemSeries.findUnique({ where: { marketId_itemId: { marketId, itemId } }, select: { points: true } })
      : Promise.resolve(null)
  ]);
  if (!item) return null;
  // A signal belongs to the generation that produced its quote. Looking it
  // up by item alone could pair the newest book with an older generation's
  // prices, which the page would then render as current.
  const signalRow = quoteRow
    ? await prisma.marketSignalRow.findUnique({
        where: { generationId_itemId: { generationId: quoteRow.generationId, itemId } },
        select: { data: true }
      })
    : null;
  return {
    item,
    quote: quoteRow?.quote ?? null,
    demandQuote,
    series: seriesRow ? arraysToSeries(seriesRow.points) : [],
    signal: signalRow ? decodeSignalRow(signalRow.data) : null
  };
}

export async function getWatchedItemIds() {
  const rows = await prisma.watchlist.findMany({ select: { itemId: true } });
  return new Set(rows.map((row) => row.itemId));
}

export async function getAlertRules() {
  return prisma.alertRule.findMany({ orderBy: { itemId: "asc" } });
}

export async function getRecipes() {
  return prisma.recipe.findMany({ orderBy: [{ profession: "asc" }, { name: "asc" }] });
}

// The shared core's sellable quantity. Bag units are sellable now; when the
// character carries none, the bank units are still a real sell candidate,
// flagged so the plan can add the bank trip. Listed units are already on
// the book and never belong in a sell action's quantity.
export async function getPositions(
  scope: MarketScope | null,
  client: Pick<typeof prisma, "holding"> = prisma
): Promise<Record<number, CorePosition>> {
  if (!scope) return {};
  const rows = await client.holding.findMany({
    where: {
      marketId: scope.id,
      ...(scope.character ? { character: scope.character } : {})
    },
    select: {
      itemId: true, qty: true, carriedQty: true, keyringQty: true, bankQty: true,
      accountBankQty: true, unknownQty: true, costKnown: true, costBasis: true
    }
  });
  const out: Record<number, CorePosition> = {};
  for (const row of rows) {
    const current = out[row.itemId];
    const bankQty = row.bankQty + row.accountBankQty;
    const requiresBank = row.carriedQty === 0 && bankQty > 0;
    const next: CorePosition = {
      qty: row.qty,
      cost: row.costBasis,
      sellableQty: row.carriedQty > 0 ? row.carriedQty : bankQty,
      costKnown: row.unknownQty === 0 && row.costKnown,
      requiresBank
    };
    if (!current) {
      out[row.itemId] = next;
    } else {
      // Defensive aggregation: the normal read is one character, but an
      // unpinned legacy scope can still return several holdings rows.
      current.qty += next.qty;
      current.cost += next.cost;
      current.sellableQty = (current.sellableQty ?? 0) + (next.sellableQty ?? 0);
      current.costKnown = current.costKnown !== false && next.costKnown !== false;
      current.requiresBank = current.requiresBank || next.requiresBank;
    }
  }
  return out;
}

export type StoredHolding = {
  character: string;
  itemId: number;
  qty: number;
  carriedQty: number;
  keyringQty: number;
  bankQty: number;
  accountBankQty: number;
  mailQty: number;
  listedQty: number;
  knownQty: number;
  unknownQty: number;
  missingQty: number;
  costKnown: boolean;
  costBasis: number;
};

// Health-page counters for the state layer: unbooked stock, ledger stock the
// observed locations do not show, and how many locations were never looked
// at. The last number is the honest coverage gap, not an error count.
export async function getReconciliationStats(scope: MarketScope | null) {
  if (!scope) {
    return { unknown: 0, missing: 0, holdings: 0, unobservedLocations: 0, planRevision: null as string | null };
  }
  const [holding, unproved, estates, generation, plan] = await Promise.all([
    prisma.holding.aggregate({
      where: { marketId: scope.id },
      _sum: { unknownQty: true, missingQty: true },
      _count: { _all: true }
    }),
    // Units the ledger booked but could not price exactly. They are present
    // in the estate, so they are unknown cost, not missing stock.
    prisma.holding.aggregate({
      where: { marketId: scope.id, costKnown: false },
      _sum: { knownQty: true }
    }),
    prisma.estate.findMany({
      where: { marketId: scope.id },
      select: { scope: true, revision: true, coverage: true }
    }),
    prisma.marketGeneration.findFirst({
      where: { marketId: scope.id },
      orderBy: { scannedAt: "desc" },
      select: { scannedAt: true }
    }),
    prisma.plan.findFirst({
      where: { marketId: scope.id, supersededAt: null },
      orderBy: { createdAt: "desc" },
      select: { revision: true, character: true, estateRevision: true, configRevision: true }
    })
  ]);
  let unobservedLocations = 0;
  for (const estate of estates) {
    const coverage = (estate.coverage ?? {}) as Record<string, unknown>;
    for (const value of Object.values(coverage)) {
      if (value !== "observed") unobservedLocations += 1;
    }
  }
  // The health page reports a plan as current only when it was minted for
  // the newest scan and this estate revision. A superseded row is history;
  // naming it here would disagree with the dashboard and the nav badge.
  const currentPlan = planMatchesScan(
    plan,
    generation?.scannedAt ?? null,
    planEstateRevision(plan, estates, scope.estateRevision)
  ) ? plan : null;
  return {
    unknown: (holding._sum.unknownQty ?? 0) + (unproved._sum.knownQty ?? 0),
    missing: holding._sum.missingQty ?? 0,
    holdings: holding._count._all,
    unobservedLocations,
    planRevision: currentPlan?.revision ?? null
  };
}

// Clean fill labels for the shared decision core: collected auction sales
// only. Inferred journal rows are excluded because they are disappearances,
// not sales, and vendor/decompose channels are not market evidence.
export async function getOwnSales(
  scope: MarketScope | null,
  at: Date = new Date(),
  client: Pick<typeof prisma, "trade"> = prisma
): Promise<OwnSales> {
  const since = new Date(at.getTime() - fillRules.ownSalesWindowDays * 24 * 60 * 60 * 1000);
  const rows = await client.trade.findMany({
    where: {
      ...(scope ? { marketId: scope.id } : {}),
      channel: "auction",
      inferred: false,
      realizedAt: { gte: since, lte: at }
    },
    select: { itemId: true, qty: true, realizedAt: true, listedAt: true }
  });
  return ownSalesFromRows(rows, at);
}

export async function getSeriesStats(marketId: string) {
  const stats = await prisma.itemSeries.aggregate({
    where: { marketId },
    _count: { _all: true },
    _sum: { pointCount: true },
    _min: { firstAt: true },
    _max: { lastAt: true }
  });
  return {
    items: stats._count._all,
    points: stats._sum.pointCount ?? 0,
    firstAt: stats._min.firstAt,
    lastAt: stats._max.lastAt
  };
}

export async function getGenerationCount(marketId: string) {
  return prisma.marketGeneration.count({ where: { marketId } });
}

export async function getImportRuns(marketId: string, limit = 20) {
  return prisma.importRun.findMany({
    where: { marketId },
    orderBy: { receivedAt: "desc" },
    take: limit
  });
}

export async function getCatalogueStats() {
  const [total, catalogue, scanOwned, placeholders, withIcon, build] = await Promise.all([
    prisma.item.count(),
    prisma.item.count({ where: { catalogSource: CATALOG_SOURCE } }),
    prisma.item.count({ where: { catalogSource: SCAN_SOURCE } }),
    prisma.item.count({ where: { name: { startsWith: "#" } } }),
    prisma.item.count({ where: { iconId: { not: null } } }),
    prisma.item.findFirst({ where: { catalogSource: CATALOG_SOURCE }, select: { catalogBuild: true } })
  ]);
  return { total, catalogue, scanOwned, placeholders, withIcon, build: build?.catalogBuild ?? null };
}
