import type { AuctionSnapshot, DailySummary, Item } from "@prisma/client";

export type ItemWithHistory = Item & {
  snapshots: AuctionSnapshot[];
  dailySummaries: DailySummary[];
};

export type MarketHistory = Omit<Item, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  snapshots: Array<Omit<AuctionSnapshot, "id" | "itemId" | "item" | "rawPayload"> & Partial<Pick<AuctionSnapshot, "id" | "itemId" | "rawPayload">>>;
  dailySummaries: Array<Omit<DailySummary, "id" | "itemId" | "item"> & Partial<Pick<DailySummary, "id" | "itemId">>>;
};

