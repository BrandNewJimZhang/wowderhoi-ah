// Snapshot-based market signals. Every statistic here follows the same
// philosophy as the in-game scanner: medians and percentiles over raw
// snapshots, never means over daily aggregates — means inherit every
// bait listing, and daily averages erase the hourly structure of the AH.
// Where the snapshot retention does not reach back to the phase window,
// older days contribute their closing sell front (a median-compatible
// statistic), never a daily mean.
//
// The anchor is the sell front. P10 remains a statistic; it is not a
// reference price and must not drive a recommendation.
import { sellPriceOf, type MarketHistory } from "@/lib/market-data";
import { median } from "@/lib/median";
import { historyWindowHours } from "@/lib/phase";
import type { MarketPhase } from "@/lib/market-rules";
import { realPrice, utcDateKey, type PriceIndex } from "@/lib/deflator";

export type MarketSignal = {
  itemId: number;
  name: string;
  category: string;
  quality: string;
  sellPrice: number; // depth-aware sell front, copper (the decision anchor)
  minPrice: number; // cheapest listed unit, copper
  price: number; // latest P10, copper; statistics only
  quantity: number; // listed quantity (supply, NOT sales)
  numAuctions: number;
  sellerCount: number;
  sellersInvisible: boolean;
  ownerVisible: boolean; // at least one listing named its owner
  sellerHHI: number | null; // other sellers' supply concentration
  topSellerShare: number | null;
  // The scan's own classification of the book; null for rows imported
  // before it was captured, where the core falls back to its derivation.
  marketType: "commodity" | "item" | null;
  bidOnlyCount: number; // direct demand signal
  highestBid: number; // highest current bid among bid-only listings, copper
  inferredSoldLow: number; // lost from an owner group: sales + cancels
  inferredSoldHigh: number; // lost from a price key: also repricing
  supplyGrowth: number; // fraction per hour
  vendorPrice: number; // NPC sell price, copper; 0 = unsellable
  // True when the item had no priced listing in the newest scan generation:
  // its prices describe a book that no longer exists and must not feed a
  // recommendation or an alert.
  stale: boolean;
  sellRef: number; // median sell front over the phase window
  sellSamples: number;
  spreadPercent: number; // (sellPrice - minPrice) / sellPrice
  trendPercent: number; // (sellPrice - sellRef) / sellRef
  changePercent: number; // sellPrice vs the previous snapshot that priced this item
  realSellPrice: number | null; // deflated by the market price index
};

export function buildMarketSignal(
  item: MarketHistory,
  now: Date,
  options?: { phase?: MarketPhase; index?: PriceIndex; currentAt?: Date }
): MarketSignal {
  const snapshots = [...item.snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (snapshots.length === 0) {
    throw new Error(`buildMarketSignal: item ${item.itemId} has no snapshots — filter empty items before signalling`);
  }
  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];
  const phase = options?.phase ?? "steady";
  const windowHours = historyWindowHours(phase);
  const windowStart = now.getTime() - windowHours * 60 * 60 * 1000;
  const windowSnapshots = snapshots.filter((snapshot) => snapshot.timestamp.getTime() >= windowStart);
  const snapshotPrices = windowSnapshots.map(sellPriceOf).filter((value) => value > 0);
  // The universe query keeps only the last 48 snapshots (about 12 hours),
  // which is shorter than the wave, settle and steady windows. Days older
  // than the snapshot window contribute their closing sell front — the
  // same statistic the median is defined over — so a 7-day reference is
  // not silently truncated to half a day. The current day's close is
  // derived from these snapshots and is never counted twice.
  const oldestSnapshotDay = snapshots.length > 0 ? utcDateKey(snapshots[0].timestamp) : null;
  const dailyPrices = item.dailySummaries
    .filter((summary) => summary.date.getTime() >= windowStart)
    .filter((summary) => oldestSnapshotDay === null || utcDateKey(summary.date) < oldestSnapshotDay)
    .map((summary) => summary.closePrice)
    .filter((value) => value > 0);
  const prices = [...dailyPrices, ...snapshotPrices];
  const sellPrice = sellPriceOf(latest);
  const sellRef = prices.length > 0 ? median(prices) : sellPrice;
  // The sample count must describe the median's inputs, not every row in the
  // window: a legacy or demand-only row carries no usable sell price.
  const sellSamples = prices.length;
  const previousSell = previous ? sellPriceOf(previous) : 0;
  return {
    itemId: item.itemId,
    name: item.name,
    category: item.category,
    quality: item.quality,
    sellPrice,
    minPrice: latest.minPrice,
    price: latest.marketPrice,
    quantity: latest.quantity,
    numAuctions: latest.numAuctions,
    sellerCount: latest.sellerCount ?? latest.numAuctions,
    sellersInvisible: latest.sellersInvisible ?? false,
    // Rows imported before the column existed cannot claim observability:
    // their flow was computed with own listings still in the book.
    ownerVisible: latest.ownerVisible === true,
    sellerHHI: latest.sellerHHI ?? null,
    topSellerShare: latest.topSellerShare ?? null,
    marketType: latest.marketType === "commodity" || latest.marketType === "item" ? latest.marketType : null,
    bidOnlyCount: latest.bidOnlyCount ?? 0,
    highestBid: latest.highestBid ?? 0,
    inferredSoldLow: latest.soldProxyLow ?? 0,
    inferredSoldHigh: Math.max(latest.soldProxyHigh ?? 0, latest.soldProxyLow ?? 0),
    supplyGrowth: latest.supplyGrowth ?? 0,
    vendorPrice: item.vendorPrice,
    stale: latest.timestamp.getTime() < (options?.currentAt ?? latest.timestamp).getTime(),
    sellRef,
    sellSamples,
    // The spread is the executable gap at today's sell front. sellRef is
    // the window reference for trend only; using it here would let a stale
    // median approve a trade that loses money at the current book.
    spreadPercent: sellPrice > 0 ? ((sellPrice - latest.minPrice) / sellPrice) * 100 : 0,
    trendPercent: sellRef > 0 ? ((sellPrice - sellRef) / sellRef) * 100 : 0,
    changePercent: previousSell > 0 ? ((sellPrice - previousSell) / previousSell) * 100 : 0,
    realSellPrice: options?.index ? realPrice(sellPrice, latest.timestamp, options.index) : null
  };
}

export type WeekdaySeasonality = {
  weekday: number; // 0 = Sunday .. 6 = Saturday (UTC)
  priceDeviation: number; // weekday median close vs overall median, percent
  listedShare: number; // weekday share of total listed quantity, percent
  sampleCount: number;
};

// WoW trading has a weekly pulse (reset day, raid nights); weekday
// medians make the cycle visible without one spike day skewing it.
export function buildWeekdaySeasonality(
  summaries: Array<{ date: Date; closePrice: number; volume: number }>
): WeekdaySeasonality[] {
  if (summaries.length === 0) return [];
  const overallMedian = median(summaries.map((summary) => summary.closePrice));
  const totalListed = summaries.reduce((sum, summary) => sum + summary.volume, 0);
  const byWeekday = new Map<number, { closes: number[]; listed: number }>();
  for (const summary of summaries) {
    const weekday = summary.date.getUTCDay();
    const bucket = byWeekday.get(weekday) ?? { closes: [], listed: 0 };
    bucket.closes.push(summary.closePrice);
    bucket.listed += summary.volume;
    byWeekday.set(weekday, bucket);
  }
  return Array.from(byWeekday.entries())
    .sort(([left], [right]) => left - right)
    .map(([weekday, bucket]) => ({
      weekday,
      priceDeviation: overallMedian === 0 ? 0 : ((median(bucket.closes) - overallMedian) / overallMedian) * 100,
      listedShare: totalListed === 0 ? 0 : (bucket.listed / totalListed) * 100,
      sampleCount: bucket.closes.length
    }));
}
