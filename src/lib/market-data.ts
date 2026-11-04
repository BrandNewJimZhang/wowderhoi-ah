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
  // Scan-time book classification. Optional for fixtures and for rows
  // imported before the column existed.
  marketType?: string | null;
  bidOnlyCount?: number;
  soldProxyLow?: number;
  soldProxyHigh?: number;
  supplyGrowth?: number;
  topTiers?: unknown;
};

export type MarketHistory = Omit<Item, "id" | "createdAt" | "updatedAt"> & {
  snapshots: MarketSnapshot[];
  dailySummaries: Array<Omit<DailySummary, "id" | "itemId" | "item" | "marketId">>;
};

