import { prisma } from "@/lib/prisma";
import { type MarketHistory } from "@/lib/market-data";

export async function getMarketUniverse(): Promise<MarketHistory[]> {
  return prisma.item.findMany({
    include: {
      snapshots: { orderBy: { timestamp: "asc" }, take: -48 },
      dailySummaries: { orderBy: { date: "asc" }, take: -30 }
    },
    orderBy: { name: "asc" }
  });
}


export async function getItemDetail(itemId: number) {
  return prisma.item.findUnique({
    where: { itemId },
    include: {
      snapshots: { orderBy: { timestamp: "asc" }, take: -96 },
      dailySummaries: { orderBy: { date: "asc" }, take: -60 }
    }
  });
}

export async function getUpcomingEvents() {
  return prisma.event.findMany({
    where: { endTime: { gte: new Date() } },
    orderBy: { startTime: "asc" },
    take: 6
  });
}

export async function getWatchedItemIds() {
  const rows = await prisma.watchlist.findMany({ select: { itemId: true } });
  return new Set(rows.map((row) => row.itemId));
}

export async function getAlertRules() {
  return prisma.alertRule.findMany({ orderBy: { itemId: "asc" } });
}


export async function getLatestSnapshotTime() {
  const row = await prisma.auctionSnapshot.findFirst({ orderBy: { timestamp: "desc" }, select: { timestamp: true } });
  return row?.timestamp ?? null;
}