// One neutral MarketSignal for tests. Every field a new signal carries has
// a default here, so adding a display field does not force a dozen fixtures
// to invent a value for a field the test never reads.
import type { MarketSignal } from "@/lib/analytics";

export function signalFixture(partial: Partial<MarketSignal> & { itemId: number }): MarketSignal {
  const sellPrice = partial.sellPrice ?? 100;
  return {
    name: `Item ${partial.itemId}`,
    category: "商品",
    subCategory: "草药",
    quality: "common",
    iconId: null,
    sellPrice,
    minPrice: Math.round(sellPrice * 0.9),
    price: sellPrice,
    quantity: 0,
    numAuctions: 0,
    sellerCount: 0,
    sellersInvisible: false,
    ownerVisible: false,
    sellerHHI: null,
    topSellerShare: null,
    marketType: null,
    bidOnlyCount: 0,
    highestBid: 0,
    inferredSoldLow: 0,
    inferredSoldHigh: 0,
    flowObserved: true,
    supplyGrowth: 0,
    vendorPrice: 0,
    stale: false,
    sellRef: sellPrice,
    sellSamples: 1,
    historySamples: 1,
    historySpanHours: null,
    tierTruncated: false,
    spreadPercent: 10,
    trendPercent: 0,
    changePercent: 0,
    spark: [sellPrice],
    priceP25: sellPrice,
    priceP75: sellPrice,
    realSellPrice: null,
    ...partial
  };
}
