import type { DailySummary, Item } from "@prisma/client";

// The analytics layer reads a market snapshot, not a Prisma row. Making
// the order-book fields optional keeps fixtures honest about what they
// exercise: a test that does not care about the ladder should not have to
// invent one.
export type MarketSnapshot = {
  timestamp: Date;
  minPrice: number;
  marketPrice: number;
  quantity: number;
  numAuctions: number;
  sellPrice?: number;
  sellerCount?: number;
  sellersInvisible?: boolean;
  ownerVisible?: boolean | null;
  sellerHHI?: number | null;
  topSellerShare?: number | null;
  // Scan-time book classification. Optional for fixtures and for rows
  // imported before the column existed.
  marketType?: string | null;
  bidOnlyCount?: number;
  highestBid?: number;
  soldProxyLow?: number;
  soldProxyHigh?: number;
  // False when the scan had no previous capture of this item, so the zero
  // interval is missing data rather than an observed zero.
  flowObserved?: boolean;
  supplyGrowth?: number;
  // Scan-time history sample count; null/undefined on older rows.
  historySamples?: number | null;
  topTiers?: unknown;
};

export type MarketHistory = Omit<Item, "id" | "createdAt" | "updatedAt"> & {
  snapshots: MarketSnapshot[];
  dailySummaries: Array<Omit<DailySummary, "id" | "itemId" | "item" | "marketId">>;
};

// The decision anchor is the sell front, but rows imported before that
// column existed carry 0, not undefined. `??` would keep the zero and erase
// the price, so those rows fall back to the P10 statistic.
export function sellPriceOf(snapshot: { sellPrice?: number; marketPrice: number }): number {
  return snapshot.sellPrice && snapshot.sellPrice > 0 ? snapshot.sellPrice : snapshot.marketPrice;
}

// Bids are a per-scan demand signal. A demand-only row from an older scan
// describes a book that is gone; showing it next to today's prices would
// claim demand the market no longer has, so only the newest generation
// qualifies.
export function currentScanDemand<T extends { timestamp: Date }>(
  row: T | null | undefined,
  latestAt: Date | null
): T | null {
  if (!row || !latestAt) return null;
  return row.timestamp.getTime() === latestAt.getTime() ? row : null;
}

