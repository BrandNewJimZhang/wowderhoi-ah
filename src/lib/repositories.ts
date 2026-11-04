import { prisma } from "@/lib/prisma";
import { type MarketHistory } from "@/lib/market-data";
import type { OwnSales } from "@/lib/core/types";
import { SCAN_INTERVAL_MINUTES, fillRules } from "@/lib/market-rules";
import type { MarketScope } from "@/lib/market-scope";

export async function getMarketUniverse(scope: MarketScope | null): Promise<MarketHistory[]> {
  const marketId = scope?.id;
  return prisma.item.findMany({
    include: {
      // Price series only: demand-only rows carry no price and must never
      // reach the signal layer.
      snapshots: { where: marketId ? { marketId, priced: true } : { priced: true }, orderBy: { timestamp: "asc" }, take: -48 },
      dailySummaries: { where: marketId ? { marketId } : {}, orderBy: { date: "asc" }, take: -30 }
    },
    orderBy: { name: "asc" }
  });
}


export async function getItemDetail(itemId: number, scope: MarketScope | null) {
  const marketId = scope?.id;
  const where = marketId ? { marketId } : {};
  // Price history and demand history are separate windows. Fetching every
  // row and filtering in the view let demand-only rows (no price) consume
  // part of the 96-snapshot chart window.
  const [item, demandSnapshot] = await Promise.all([
    prisma.item.findUnique({
      where: { itemId },
      include: {
        snapshots: { where: { ...where, priced: true }, orderBy: { timestamp: "asc" }, take: -96 },
        dailySummaries: { where, orderBy: { date: "asc" }, take: -60 }
      }
    }),
    prisma.auctionSnapshot.findFirst({
      where: { ...where, itemId, bidOnlyCount: { gt: 0 } },
      orderBy: { timestamp: "desc" }
    })
  ]);
  return item ? { ...item, demandSnapshot } : null;
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


export async function getLatestSnapshotTime(scope: MarketScope | null) {
  const row = await prisma.auctionSnapshot.findFirst({
    where: scope ? { marketId: scope.id } : {},
    orderBy: { timestamp: "desc" },
    select: { timestamp: true }
  });
  return row?.timestamp ?? null;
}

export async function getEarliestSnapshotTime(scope: MarketScope | null) {
  const row = await prisma.auctionSnapshot.findFirst({
    where: scope ? { marketId: scope.id } : {},
    orderBy: { timestamp: "asc" },
    select: { timestamp: true }
  });
  return row?.timestamp ?? null;
}

export async function getRecipes() {
  return prisma.recipe.findMany({ orderBy: [{ profession: "asc" }, { name: "asc" }] });
}

export async function getPositions(scope: MarketScope | null): Promise<Record<number, { qty: number; cost: number }>> {
  const rows = await prisma.position.findMany({
    where: scope ? { marketId: scope.id } : {},
    select: { itemId: true, qty: true, costBasis: true }
  });
  return Object.fromEntries(rows.map((row) => [row.itemId, { qty: row.qty, cost: row.costBasis }]));
}

// Clean fill labels for the shared decision core: collected auction sales
// only. Inferred journal rows are excluded because they are disappearances,
// not sales, and vendor/decompose channels are not market evidence.
export async function getOwnSales(scope: MarketScope | null): Promise<OwnSales> {
  const since = new Date(Date.now() - fillRules.ownSalesWindowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.trade.findMany({
    where: {
      ...(scope ? { marketId: scope.id } : {}),
      channel: "auction",
      inferred: false,
      realizedAt: { gte: since }
    },
    select: { itemId: true, qty: true, realizedAt: true }
  });
  const byItem = new Map<number, { qty: number; samples: number; first: number; last: number }>();
  for (const row of rows) {
    const at = row.realizedAt.getTime();
    const record = byItem.get(row.itemId) ?? { qty: 0, samples: 0, first: at, last: at };
    record.qty += row.qty;
    record.samples += 1;
    record.first = Math.min(record.first, at);
    record.last = Math.max(record.last, at);
    byItem.set(row.itemId, record);
  }
  return Object.fromEntries(
    Array.from(byItem.entries()).map(([itemId, record]) => [
      itemId,
      {
        qty: record.qty,
        samples: record.samples,
        // The scan interval is the resolution floor.
        elapsedHours: Math.max((record.last - record.first) / (60 * 60 * 1000), SCAN_INTERVAL_MINUTES / 60)
      }
    ])
  );
}