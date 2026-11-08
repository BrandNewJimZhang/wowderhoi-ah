// The analytics layer reads a market history, not a Prisma row. Keeping the
// shape structural means a new catalogue column does not force every
// fixture to invent a value for a field analytics never reads.

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
  // Scan-time hours the history points span; null/undefined on older rows.
  historySpanHours?: number | null;
  // True when topTiers is only the top of a deeper book.
  tierTruncated?: boolean;
  topTiers?: unknown;
};

export type MarketDailySummary = {
  date: Date;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
};

export type MarketHistory = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
  iconId?: number | null;
  snapshots: MarketSnapshot[];
  dailySummaries: MarketDailySummary[];
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

