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

// Positions and trades are rewritten by every import, including the
// journal-only replay the mailbox triggers between scans. The signal bundle
// caches per scan generation, so without this token a confirmed sale would
// only reach the cockpit at the next scan. Counts, quantities and sums move
// on buys, sales and confirm upgrades (which replace an inferred row in
// place and therefore change pnl/fee without adding a row).
export async function getLedgerRevision(scope: MarketScope | null): Promise<string> {
  const where = scope ? { marketId: scope.id } : {};
  const [trades, positions] = await Promise.all([
    prisma.trade.aggregate({
      where,
      _count: { _all: true },
      _max: { realizedAt: true },
      _sum: { pnl: true, fee: true }
    }),
    prisma.position.aggregate({ where, _count: { _all: true }, _sum: { qty: true, costBasis: true } })
  ]);
  return [
    trades._count._all,
    trades._max.realizedAt?.getTime() ?? 0,
    trades._sum.pnl ?? 0,
    trades._sum.fee ?? 0,
    positions._count._all,
    positions._sum.qty ?? 0,
    positions._sum.costBasis ?? 0
  ].join(":");
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
    select: { itemId: true, qty: true, realizedAt: true, listedAt: true }
  });
  const floorMs = (SCAN_INTERVAL_MINUTES / 60) * 60 * 60 * 1000;
  const byItem = new Map<number, { qty: number; samples: number; exposureMs: number }>();
  for (const row of rows) {
    const observedAt = row.realizedAt.getTime();
    const listedAt = row.listedAt?.getTime() ?? observedAt - floorMs;
    // Exposure is per sale: how long that listing waited on the book. The
    // span between the first and last sale understates it when several
    // listings sold close together. The window bounds which sales count,
    // not how long a sale waited.
    const exposure = Math.max(observedAt - listedAt, floorMs);
    const record = byItem.get(row.itemId) ?? { qty: 0, samples: 0, exposureMs: 0 };
    record.qty += row.qty;
    record.samples += 1;
    record.exposureMs += exposure;
    byItem.set(row.itemId, record);
  }
  return Object.fromEntries(
    Array.from(byItem.entries()).map(([itemId, record]) => [
      itemId,
      {
        qty: record.qty,
        samples: record.samples,
        exposedHours: Math.max(record.exposureMs / (60 * 60 * 1000), SCAN_INTERVAL_MINUTES / 60)
      }
    ])
  );
}