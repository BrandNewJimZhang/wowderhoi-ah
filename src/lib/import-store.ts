// The write half of an import: a generation, its quotes, signals, series
// and decisions. The route and the one-off migration share this so a
// migrated market is byte-for-byte the shape a live import produces.
import { Prisma } from "@prisma/client";
import type { GenerationPlan, DecisionRow } from "@/lib/market-generation";
import { seriesToArrays } from "@/lib/item-series";
import type { MarketQuote } from "@/lib/market-data";

const QUOTE_BATCH = 1000;
const SIGNAL_BATCH = 1000;
const SERIES_BATCH = 500;
const DECISION_BATCH = 200;
const ID_CHUNK = 500;

export function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

export type StoredDecision = DecisionRow & { adoptedAt: Date | null };

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

export async function writeGeneration(
  tx: Prisma.TransactionClient,
  marketId: string,
  plan: GenerationPlan,
  decisions: StoredDecision[],
  ledgerRevision: string
): Promise<string> {
  const generation = await tx.marketGeneration.create({
    data: {
      marketId,
      scannedAt: plan.scannedAt,
      phase: plan.phase,
      breadth: plan.breadth,
      staleCount: plan.staleCount,
      firstScanAt: plan.firstScanAt,
      priceIndex: plan.priceIndex as unknown as Prisma.InputJsonValue,
      core: plan.core as unknown as Prisma.InputJsonValue,
      ledgerRevision,
      gapMinutes: plan.gapMinutes
    }
  });
  for (const batch of chunks(plan.quotes, QUOTE_BATCH)) {
    await tx.marketQuote.createMany({ data: batch.map((row) => quoteCreateData(row, generation.id, marketId)) });
  }
  for (const batch of chunks(plan.signals, SIGNAL_BATCH)) {
    await tx.marketSignalRow.createMany({
      data: batch.map((row) => ({
        generationId: generation.id,
        itemId: row.itemId,
        data: row.data as unknown as Prisma.InputJsonValue
      }))
    });
  }
  for (const batch of chunks(plan.series.map((row) => row.itemId), ID_CHUNK)) {
    await tx.itemSeries.deleteMany({ where: { marketId, itemId: { in: batch } } });
  }
  for (const batch of chunks(plan.series, SERIES_BATCH)) {
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
  for (const batch of chunks(decisions, DECISION_BATCH)) {
    await tx.decision.createMany({
      data: batch.map((row) => ({
        ...row,
        marketId,
        generationId: generation.id,
        at: plan.scannedAt,
        phase: plan.phase
      }))
    });
  }
  return generation.id;
}

export async function replaceDecisions(
  tx: Prisma.TransactionClient,
  generationId: string,
  marketId: string,
  scannedAt: Date,
  phase: string,
  decisions: StoredDecision[]
): Promise<void> {
  await tx.decision.deleteMany({ where: { generationId } });
  for (const batch of chunks(decisions, DECISION_BATCH)) {
    await tx.decision.createMany({
      data: batch.map((row) => ({ ...row, marketId, generationId, at: scannedAt, phase }))
    });
  }
}
