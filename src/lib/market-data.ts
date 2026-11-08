// The shapes the analytics layer consumes. A quote is one item's book in
// one scan; a series point is one price observation in the addon history.
// Keeping them separate is what lets the current book and the long history
// have different lifetimes.

export type MarketQuote = {
  timestamp: Date;
  // A demand-only row (bid-only listings, no buyout) has priced=false and
  // zero price columns; only bidOnlyCount/highestBid are meaningful.
  priced: boolean;
  minPrice: number;
  marketPrice: number; // P10; a statistic, not a decision anchor
  sellPrice: number; // depth-aware sell front
  p5Price: number;
  quantity: number;
  numAuctions: number;
  sellerCount: number;
  sellersInvisible: boolean;
  // True when the scan could see owner names for this item. Hidden owners
  // make the flow proxy unobservable rather than zero.
  ownerVisible: boolean;
  // Hygiene generation of the flow columns; null on scans from older
  // builds, which calibration must not mix with clean rows.
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

// The static facts a signal needs from the catalogue. Structural, so a new
// catalogue column does not force every fixture to invent it.
export type SignalItem = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
  iconId: number | null;
};

// The decision anchor is the sell front, but rows imported before that
// column existed carry 0, not undefined. `??` would keep the zero and
// erase the price, so those rows fall back to the P10 statistic.
export function sellPriceOf(quote: { sellPrice?: number; marketPrice: number }): number {
  return quote.sellPrice && quote.sellPrice > 0 ? quote.sellPrice : quote.marketPrice;
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

// When the displayed price was observed. A bid-only scan writes a quote but
// no series point, so the quote's timestamp describes demand, not the price;
// the last series point is the price's true observation. A series point
// later than the newest generation is clamped: a replayed older scan must
// not make its prices look current.
export function priceObservationAt(
  series: ReadonlyArray<{ t: number }>,
  quote: { timestamp: Date } | null,
  latestScanAt: Date | null
): Date | null {
  const last = series.length > 0 ? series[series.length - 1].t : null;
  if (last === null) return quote?.timestamp ?? null;
  const at = new Date(last * 1000);
  return latestScanAt && at.getTime() > latestScanAt.getTime() ? latestScanAt : at;
}
