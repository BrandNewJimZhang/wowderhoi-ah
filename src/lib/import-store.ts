// The write half of an import: a generation, its quotes, signals, series
// and decisions. The route and the one-off migration share this so a
// migrated market is byte-for-byte the shape a live import produces.
import { Prisma } from "@prisma/client";
import type { GenerationPlan, DecisionRow, SeriesRow } from "@/lib/market-generation";
import { seriesToArrays } from "@/lib/item-series";
import type { MarketQuote } from "@/lib/market-data";
import type { StoredSignalRow } from "@/lib/signal-row";

const QUOTE_BATCH = 1000;
const SIGNAL_BATCH = 1000;
const SERIES_BATCH = 500;
const DECISION_BATCH = 200;
const ID_CHUNK = 500;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

type StoredDecision = DecisionRow & { adoptedAt?: Date | null };

type SignalInsert = { itemId: number; data: StoredSignalRow };

async function insertSignals(
  tx: Prisma.TransactionClient,
  generationId: string,
  rows: readonly SignalInsert[]
): Promise<void> {
  for (const batch of chunks(rows, SIGNAL_BATCH)) {
    await tx.marketSignalRow.createMany({
      data: batch.map((row) => ({
        generationId,
        itemId: row.itemId,
        data: row.data as unknown as Prisma.InputJsonValue
      }))
    });
  }
}

function quoteCreateData(
  row: { itemId: number; quote: MarketQuote },
  generationId: string,
  marketId: string
): Prisma.MarketQuoteCreateManyInput {
  const quote = row.quote;
  return {
    generationId,
    marketId,
    itemId: row.itemId,
    priced: quote.priced,
    minPrice: quote.minPrice,
    marketPrice: quote.marketPrice,
    sellPrice: quote.sellPrice,
    p5Price: quote.p5Price,
    quantity: quote.quantity,
    numAuctions: quote.numAuctions,
    sellerCount: quote.sellerCount,
    sellersInvisible: quote.sellersInvisible,
    ownerVisible: quote.ownerVisible,
    observationVersion: quote.observationVersion,
    sellerHHI: quote.sellerHHI,
    topSellerShare: quote.topSellerShare,
    marketType: quote.marketType,
    bidOnlyCount: quote.bidOnlyCount,
    highestBid: quote.highestBid,
    soldProxyLow: quote.soldProxyLow,
    soldProxyHigh: quote.soldProxyHigh,
    flowObserved: quote.flowObserved,
    supplyGrowth: quote.supplyGrowth,
    historySamples: quote.historySamples,
    historySpanHours: quote.historySpanHours,
    tierTruncated: quote.tierTruncated,
    topTiers: quote.topTiers === null || quote.topTiers === undefined
      ? Prisma.JsonNull
      : (quote.topTiers as Prisma.InputJsonValue),
    expiring: quote.expiring === null || quote.expiring === undefined
      ? Prisma.JsonNull
      : (quote.expiring as Prisma.InputJsonValue)
  };
}

// Series rows are replaced by item id, never the whole table: items whose
// addon history has aged out of the payload keep their terminal copy.
export async function replaceSeries(
  tx: Prisma.TransactionClient,
  marketId: string,
  series: readonly SeriesRow[]
): Promise<void> {
  for (const batch of chunks(series.map((row) => row.itemId), ID_CHUNK)) {
    await tx.itemSeries.deleteMany({ where: { marketId, itemId: { in: batch } } });
  }
  for (const batch of chunks(series, SERIES_BATCH)) {
    await tx.itemSeries.createMany({
      data: batch.map((row) => ({
        marketId,
        itemId: row.itemId,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        pointCount: row.pointCount,
        points: seriesToArrays(row.points) as unknown as Prisma.InputJsonValue
      }))
    });
  }
}

// A replayed scan can re-create a generation that pruning removed while the
// decisions it wrote are still inside the log. The decision id is unique and
// names the same recommendation, so the rebuilt row supersedes the surviving
// one: deleting first keeps a replay from failing the import, and an adoption
// is a player fact that must survive the rebuild.
async function replaceDecisionsByIdentity(
  tx: Prisma.TransactionClient,
  marketId: string,
  scannedAt: Date,
  phase: string,
  decisions: StoredDecision[]
): Promise<void> {
  const adoptedBefore = new Map<string, Date | null>();
  for (const batch of chunks(decisions.map((row) => row.decisionId), DECISION_BATCH)) {
    const existing = await tx.decision.findMany({
      where: { decisionId: { in: batch } },
      select: { decisionId: true, adoptedAt: true }
    });
    for (const row of existing) {
      if (row.decisionId) adoptedBefore.set(row.decisionId, row.adoptedAt);
    }
    await tx.decision.deleteMany({ where: { decisionId: { in: batch } } });
  }
  for (const batch of chunks(decisions, DECISION_BATCH)) {
    await tx.decision.createMany({
      data: batch.map((row) => ({
        ...row,
        adoptedAt: row.adoptedAt ?? adoptedBefore.get(row.decisionId) ?? null,
        marketId,
        at: scannedAt,
        phase
      }))
    });
  }
}

export async function writeGeneration(
  tx: Prisma.TransactionClient,
  marketId: string,
  plan: GenerationPlan,
  decisions: StoredDecision[]
): Promise<string> {
  const generation = await tx.marketGeneration.create({
    data: {
      marketId,
      scannedAt: plan.scannedAt,
      character: plan.character ?? "",
      phase: plan.phase,
      breadth: plan.breadth,
      staleCount: plan.staleCount,
      firstScanAt: plan.firstScanAt,
      priceIndex: plan.priceIndex as unknown as Prisma.InputJsonValue,
      core: plan.core as unknown as Prisma.InputJsonValue,
      gapMinutes: plan.gapMinutes
    }
  });
  for (const batch of chunks(plan.quotes, QUOTE_BATCH)) {
    await tx.marketQuote.createMany({ data: batch.map((row) => quoteCreateData(row, generation.id, marketId)) });
  }
  await insertSignals(tx, generation.id, plan.signals);
  await replaceSeries(tx, marketId, plan.series);
  await replaceDecisionsByIdentity(tx, marketId, plan.scannedAt, plan.phase, decisions);
  return generation.id;
}
