// Quote-based market signals, read against the addon series. Every statistic here follows the same
// philosophy as the in-game scanner: medians and percentiles over raw
// series points, never means over daily aggregates — means inherit every
// bait listing, and daily averages erase the hourly structure of the AH.
// The series is the addon's own layered history, so a 7-day reference is
// not silently truncated to the 48 rows a display query happens to keep.
//
// The anchor is the sell front. P10 remains a statistic; it is not a
// reference price and must not drive a recommendation.
import { sellPriceOf, type MarketQuote, type SignalItem } from "@/lib/market-data";
import type { SeriesPoint } from "@/lib/item-series";
import { seriesSamples, seriesSpanHours, seriesWindow, sparkSeries } from "@/lib/item-series";
import { median, quantile } from "@/lib/median";
import { historyWindowHours } from "@/lib/phase";
import type { MarketPhase } from "@/lib/market-rules";
import { realPrice, type PriceIndex } from "@/lib/deflator";

export type MarketSignal = {
  itemId: number;
  name: string;
  category: string;
  subCategory: string;
  quality: string;
  // Catalogue icon id; null on scan-only items the public catalogue does
  // not know.
  iconId: number | null;
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
  // False when the scan had no previous capture of the item: the zero
  // interval is missing data, so it must not make the book "observed".
  flowObserved: boolean;
  supplyGrowth: number; // fraction per hour
  // NPC sell price, copper. Null = no source resolved it; 0 = unsellable.
  // The core treats both as "no vendor arbitrage", but the UI must not
  // print an unknown price as zero.
  vendorPrice: number | null;
  // True when the item had no priced listing in the newest scan generation:
  // its prices describe a book that no longer exists and must not feed a
  // recommendation or an alert.
  stale: boolean;
  sellRef: number; // median sell front over the phase window
  sellSamples: number;
  // History points inside the phase window. The scanner's own stamp wins;
  // without one the series answers the same question.
  historySamples: number;
  // Hours those points span. Null when there is only one observation: the
  // core then applies the sample floor alone instead of inventing coverage.
  historySpanHours: number | null;
  // The persisted ladder is a truncated top-of-book; the queue behind a
  // listing above the last visible rung is larger than the rows shown.
  tierTruncated: boolean;
  spreadPercent: number; // (sellPrice - minPrice) / sellPrice
  trendPercent: number; // (sellPrice - sellRef) / sellRef
  changePercent: number; // sellPrice vs the previous series point
  // Downsampled sell-front history for the table sparkline.
  spark: number[];
  // Quartiles of the sell front inside the phase window; display only.
  priceP25: number;
  priceP75: number;
  realSellPrice: number | null; // deflated by the market price index
};

export type SignalInput = {
  item: SignalItem;
  quote: MarketQuote;
  // Ascending by timestamp. Includes the quote's own point when the scan
  // was priced.
  series: readonly SeriesPoint[];
};

export function buildMarketSignal(
  input: SignalInput,
  now: Date,
  options?: { phase?: MarketPhase; index?: PriceIndex; currentAt?: Date }
): MarketSignal {
  const { item, quote, series } = input;
  const nowSeconds = Math.round(now.getTime() / 1000);
  const phase = options?.phase ?? "steady";
  const windowHours = historyWindowHours(phase);
  const window = seriesWindow(series, nowSeconds, windowHours);
  const prices = window.map((point) => point.sellPrice).filter((value) => value > 0);
  const sellPrice = sellPriceOf(quote);
  const sellRef = prices.length > 0 ? median(prices) : sellPrice;
  const quoteSeconds = Math.round(quote.timestamp.getTime() / 1000);
  let previous: SeriesPoint | null = null;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].t < quoteSeconds) {
      previous = series[index];
      break;
    }
  }
  const previousSell = previous?.sellPrice ?? 0;
  // A single-point window still gets a sparkline; points after the scan
  // never do.
  const sparkWindow = window.length >= 2 ? window : series.filter((point) => point.t <= nowSeconds);
  return {
    itemId: item.itemId,
    name: item.name,
    category: item.category,
    subCategory: item.subCategory,
    quality: item.quality,
    iconId: item.iconId,
    sellPrice,
    minPrice: quote.minPrice,
    price: quote.marketPrice,
    quantity: quote.quantity,
    numAuctions: quote.numAuctions,
    sellerCount: quote.sellerCount,
    sellersInvisible: quote.sellersInvisible,
    ownerVisible: quote.ownerVisible,
    sellerHHI: quote.sellerHHI,
    topSellerShare: quote.topSellerShare,
    marketType: quote.marketType === "commodity" || quote.marketType === "item" ? quote.marketType : null,
    bidOnlyCount: quote.bidOnlyCount,
    highestBid: quote.highestBid,
    inferredSoldLow: quote.soldProxyLow,
    inferredSoldHigh: Math.max(quote.soldProxyHigh, quote.soldProxyLow),
    flowObserved: quote.flowObserved,
    supplyGrowth: quote.supplyGrowth,
    vendorPrice: item.vendorPrice,
    stale: quote.timestamp.getTime() < (options?.currentAt ?? quote.timestamp).getTime(),
    sellRef,
    sellSamples: prices.length,
    historySamples: quote.historySamples ?? seriesSamples(series, nowSeconds, windowHours),
    historySpanHours: quote.historySpanHours ?? (() => {
      const span = seriesSpanHours(series, nowSeconds, windowHours);
      return span > 0 ? span : null;
    })(),
    tierTruncated: quote.tierTruncated,
    // The spread is the executable gap at today's sell front. sellRef is
    // the window reference for trend only; using it here would let a stale
    // median approve a trade that loses money at the current book.
    spreadPercent: sellPrice > 0 ? ((sellPrice - quote.minPrice) / sellPrice) * 100 : 0,
    trendPercent: sellRef > 0 ? ((sellPrice - sellRef) / sellRef) * 100 : 0,
    changePercent: previousSell > 0 ? ((sellPrice - previousSell) / previousSell) * 100 : 0,
    spark: sparkSeries(sparkWindow),
    priceP25: prices.length > 0 ? quantile(prices, 0.25) : sellPrice,
    priceP75: prices.length > 0 ? quantile(prices, 0.75) : sellPrice,
    realSellPrice: options?.index ? realPrice(sellPrice, quote.timestamp, options.index) : null
  };
}

type WeekdaySeasonality = {
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
