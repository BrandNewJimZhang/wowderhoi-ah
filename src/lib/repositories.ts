import { prisma } from "@/lib/prisma";
import type { MarketQuote } from "@/lib/market-data";
import { arraysToSeries, type SeriesPoint } from "@/lib/item-series";
import { decodeGeneration, type GenerationRecord } from "@/lib/generation-record";
import { decodeSignalRow, type StoredSignalRow } from "@/lib/signal-row";
import { ownSalesFromRows } from "@/lib/own-sales";
import { ledgerRevisionOf } from "@/lib/ledger-revision";
import type { OwnSales } from "@/lib/core/types";
import { fillRules } from "@/lib/market-rules";
import { CATALOG_SOURCE, SCAN_SOURCE } from "@/lib/item-catalog";
import type { MarketScope } from "@/lib/market-scope";

const GENERATION_SELECT = {
  id: true, marketId: true, scannedAt: true, phase: true, breadth: true, staleCount: true,
  firstScanAt: true, priceIndex: true, core: true, ledgerRevision: true, gapMinutes: true
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

// Positions and trades are rewritten by every import, including the
// journal-only replay the mailbox triggers between scans.
export async function getLedgerRevision(scope: MarketScope | null): Promise<string> {
  const where = scope ? { marketId: scope.id } : {};
  const [trades, positions] = await Promise.all([
    prisma.trade.findMany({ where, select: { realizedAt: true, pnl: true, fee: true } }),
    prisma.position.findMany({ where, select: { qty: true, costBasis: true } })
  ]);
  return ledgerRevisionOf(
    trades,
    positions.map((position) => ({ qty: position.qty, cost: position.costBasis }))
  );
}

export async function getPositions(scope: MarketScope | null): Promise<Record<number, { qty: number; cost: number }>> {
  const rows = await prisma.position.findMany({
    where: scope ? { marketId: scope.id } : {},
    select: { itemId: true, qty: true, costBasis: true }
  });
  return Object.fromEntries(rows.map((row) => [row.itemId, { qty: row.qty, cost: row.costBasis }]));
}

// Clean fill labels for the shared decision core: collected auction sales
// only. Inferred journal rows are excluded because they are disappearances,
// not sales, and vendor/decompose channels are not market evidence.
export async function getOwnSales(scope: MarketScope | null): Promise<OwnSales> {
  const since = new Date(Date.now() - fillRules.ownSalesWindowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.trade.findMany({
    where: {
      ...(scope ? { marketId: scope.id } : {}),
      channel: "auction",
      inferred: false,
      realizedAt: { gte: since }
    },
    select: { itemId: true, qty: true, realizedAt: true, listedAt: true }
  });
  return ownSalesFromRows(rows);
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
  const [total, catalogue, scanOwned, placeholders, withIcon] = await Promise.all([
    prisma.item.count(),
    prisma.item.count({ where: { catalogSource: CATALOG_SOURCE } }),
    prisma.item.count({ where: { catalogSource: SCAN_SOURCE } }),
    prisma.item.count({ where: { name: { startsWith: "#" } } }),
    prisma.item.count({ where: { iconId: { not: null } } })
  ]);
  return { total, catalogue, scanOwned, placeholders, withIcon };
}
