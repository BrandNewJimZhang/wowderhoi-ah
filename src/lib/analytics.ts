// Snapshot-based market signals. Every statistic here follows the same
// philosophy as the in-game scanner: medians and percentiles over raw
// snapshots, never means over daily aggregates — means inherit every
// bait listing, and daily closes erase the hourly structure of the AH.
import type { MarketHistory } from "@/lib/market-data";
import { dealRadarRules } from "@/lib/market-rules";

export type MarketSignal = {
  itemId: number;
  name: string;
  category: string;
  quality: string;
  price: number; // latest scan's P10 unit price, copper
  minPrice: number; // latest scan's minimum listed unit price
  quantity: number; // latest scan's listed quantity (supply, NOT sales)
  numAuctions: number;
  vendorPrice: number; // NPC sell price, copper; 0 = unsellable
  med7: number; // median snapshot P10 over the last 7 days
  med7Samples: number; // snapshots inside the 7d window backing med7
  discountPercent: number; // how far the current min sits below med7
  changePercent: number; // latest P10 vs the previous scan's P10
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MED_WINDOW_DAYS = 7;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

export function buildMarketSignal(item: MarketHistory, now: Date): MarketSignal {
  const snapshots = [...item.snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (snapshots.length === 0) {
    throw new Error(`buildMarketSignal: item ${item.itemId} has no snapshots — filter empty items before signalling`);
  }
  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];
  const windowStart = now.getTime() - MED_WINDOW_DAYS * DAY_MS;
  const windowPrices = snapshots
    .filter((snapshot) => snapshot.timestamp.getTime() >= windowStart)
    .map((snapshot) => snapshot.marketPrice);
  const med7 = windowPrices.length > 0 ? median(windowPrices) : latest.marketPrice;
  return {
    itemId: item.itemId,
    name: item.name,
    category: item.category,
    quality: item.quality,
    price: latest.marketPrice,
    minPrice: latest.minPrice,
    quantity: latest.quantity,
    numAuctions: latest.numAuctions,
    vendorPrice: item.vendorPrice,
    med7,
    med7Samples: windowPrices.length,
    discountPercent: med7 > 0 ? (1 - latest.minPrice / med7) * 100 : 0,
    changePercent: previous && previous.marketPrice > 0 ? ((latest.marketPrice - previous.marketPrice) / previous.marketPrice) * 100 : 0
  };
}

export type DealRadarRow = {
  itemId: number;
  name: string;
  quality: string;
  minPrice: number;
  reference: number; // vendorPrice for vendor deals, med7 otherwise
  profit: number; // copper spread between reference and current min
  vendor: boolean;
  discountPercent: number;
};

// Deal radar, mirroring addon/WoWderhoiAH/Trade.lua refreshDeals: the two
// implementations must classify the same scan identically or the terminal
// promises deals the in-game buy list can't deliver. Both read the same
// thresholds from the single source of truth (src/lib/market-rules.ts).
const { minProfit: RADAR_MIN_PROFIT, discount: RADAR_DISCOUNT, minAuctions: RADAR_MIN_AUCTIONS, minHistory: RADAR_MIN_HISTORY } = dealRadarRules;

export function buildDealRadar(signals: MarketSignal[]): DealRadarRow[] {
  const deals: DealRadarRow[] = [];
  for (const signal of signals) {
    // Class 1: vendor arbitrage. Listed below the NPC sell price is a
    // guaranteed profit with zero market risk — no history needed, and no
    // profit floor either: the NPC always buys, so even a 1c spread is
    // free money the moment you're already at the AH.
    if (signal.vendorPrice > 0 && signal.minPrice > 0 && signal.minPrice < signal.vendorPrice) {
      deals.push({
        itemId: signal.itemId,
        name: signal.name,
        quality: signal.quality,
        minPrice: signal.minPrice,
        reference: signal.vendorPrice,
        profit: signal.vendorPrice - signal.minPrice,
        vendor: true,
        discountPercent: (1 - signal.minPrice / signal.vendorPrice) * 100
      });
    // Class 2: P10 median discount. Requires history depth (3+ scans) AND a
    // live market (3+ auctions) AND a worthwhile absolute spread —
    // otherwise the list fills with illiquid junk nobody ever buys.
    } else if (signal.med7Samples >= RADAR_MIN_HISTORY && signal.med7 > 0 && signal.minPrice > 0
      && signal.numAuctions >= RADAR_MIN_AUCTIONS
      && signal.med7 - signal.minPrice >= RADAR_MIN_PROFIT
      && signal.minPrice <= signal.med7 * RADAR_DISCOUNT) {
      deals.push({
        itemId: signal.itemId,
        name: signal.name,
        quality: signal.quality,
        minPrice: signal.minPrice,
        reference: signal.med7,
        profit: signal.med7 - signal.minPrice,
        vendor: false,
        discountPercent: signal.discountPercent
      });
    }
  }
  // Vendor deals first (risk-free), then by absolute profit.
  return deals.sort((left, right) => {
    if (left.vendor !== right.vendor) return left.vendor ? -1 : 1;
    return right.profit - left.profit;
  });
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
