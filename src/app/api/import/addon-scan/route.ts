import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan, type AddonScan } from "@/lib/addon-scan";
import { mergeScanIntoDailySummaries } from "@/lib/daily-summary";
import { diffScanItems } from "@/lib/scan-import";
import { aggregateSeriesDays, parseAddonSeries, selectSeriesBackfill, type AddonSeries } from "@/lib/series-import";
import { placeholderItemName } from "@/lib/item-name";
import { bookForCharacter, parseJournal, replayJournal, type ReplayState } from "@/lib/journal";

// A missed scan is backfilled as price/listings history only. Bounded so one
// import cannot turn into an unbounded write; the addon keeps the rest.
const SERIES_BACKFILL_LIMIT = 16;
// Prisma/SQLite bind one parameter per column; keep a createMany well inside
// the driver's parameter budget.
const SNAPSHOT_BATCH = 2000;

// The journal projection is replaced wholesale on every import: the replay
// is the single authority for positions and realized trades.
function journalStatements(replay: ReplayState, marketId: string): Prisma.PrismaPromise<unknown>[] {
  const positions = Object.entries(replay.positions).map(([itemId, position]) => ({
    marketId,
    itemId: Number(itemId),
    qty: position.qty,
    costBasis: position.cost
  }));
  const trades = replay.trades.map((trade) => ({
    marketId,
    itemId: trade.itemId ?? 0,
    qty: trade.qty,
    price: trade.price,
    fee: trade.fee,
    pnl: trade.pnl,
    channel: trade.channel,
    inferred: trade.inferred,
    listedAt: trade.listedAt ? new Date(trade.listedAt * 1000) : null,
    realizedAt: new Date(trade.t * 1000)
  }));
  return [
    prisma.position.deleteMany({ where: { marketId } }),
    ...(positions.length > 0 ? [prisma.position.createMany({ data: positions })] : []),
    prisma.trade.deleteMany({ where: { marketId } }),
    ...(trades.length > 0 ? [prisma.trade.createMany({ data: trades })] : [])
  ];
}

type BackfillResult = {
  statements: Prisma.PrismaPromise<unknown>[];
  timestamps: number[];
  skipped: number;
};

// Scans completed while the watcher was not running survive only in the
// addon's series. Deliver the ones the database has never seen, newest first
// and bounded per import. The same builder serves a new scan and a duplicate:
// after a watcher restart the latest scan is already in the database while
// the scans before it may be missing, and that replay is exactly when the
// backfill matters.
async function buildBackfillStatements(
  scan: AddonScan,
  series: AddonSeries | null,
  marketId: string,
  knownItemIds: Set<number>
): Promise<BackfillResult> {
  if (!series) return { statements: [], timestamps: [], skipped: 0 };
  const currentScanAt = Math.round(scan.scannedAt.getTime() / 1000);
  const existingStamps = await prisma.auctionSnapshot.findMany({
    where: { marketId, timestamp: { lt: scan.scannedAt } },
    select: { timestamp: true },
    distinct: ["timestamp"]
  });
  const backfill = selectSeriesBackfill(
    series,
    existingStamps.map((row) => Math.round(row.timestamp.getTime() / 1000)),
    currentScanAt,
    SERIES_BACKFILL_LIMIT
  );
  if (backfill.points.length === 0) {
    return { statements: [], timestamps: backfill.timestamps, skipped: backfill.skipped };
  }

  // Backfilled items may not appear in the current scan. The Item row is the
  // snapshot's foreign key, so every referenced id must exist before the
  // snapshot batch runs. `knownItemIds` includes the rows the caller is about
  // to create in the same transaction.
  const itemCreates: Array<{ itemId: number; name: string; quality: string; category: string; subCategory: string; vendorPrice: number }> = [];
  const snapshots: Prisma.AuctionSnapshotCreateManyInput[] = [];
  for (const point of backfill.points) {
    if (!knownItemIds.has(point.itemId)) {
      knownItemIds.add(point.itemId);
      itemCreates.push({
        itemId: point.itemId,
        name: placeholderItemName(point.itemId),
        quality: "unknown",
        category: "unknown",
        subCategory: "unknown",
        vendorPrice: 0
      });
    }
    snapshots.push({
      itemId: point.itemId,
      timestamp: new Date(point.timestamp * 1000),
      marketId,
      priced: true,
      minPrice: point.minPrice,
      marketPrice: point.minPrice,
      sellPrice: point.sellPrice,
      // The series does not carry P10, tiers, sellers or flow. Zero/null is
      // an honest "not observed", not a measured zero.
      p5Price: 0,
      quantity: point.quantity,
      numAuctions: point.numAuctions,
      sellerCount: point.numAuctions,
      sellersInvisible: false,
      ownerVisible: false,
      observationVersion: null,
      marketType: null,
      flowObserved: false
    });
  }

  const aggregates = aggregateSeriesDays(backfill.points, scan.scannedAt);
  const aggregateDates = Array.from(new Set(aggregates.map((row) => row.date.toISOString())))
    .map((iso) => new Date(iso));
  const existingDayRows = aggregateDates.length === 0 ? [] : await prisma.dailySummary.findMany({
    where: { marketId, date: { in: aggregateDates } },
    select: { itemId: true, date: true, highPrice: true, lowPrice: true }
  });
  const existingByKey = new Map(existingDayRows.map((row) => [`${row.date.toISOString()}|${row.itemId}`, row]));
  const newDayRows: Prisma.DailySummaryCreateManyInput[] = [];
  const dayUpdates: Prisma.PrismaPromise<unknown>[] = [];
  for (const aggregate of aggregates) {
    const existing = existingByKey.get(`${aggregate.date.toISOString()}|${aggregate.itemId}`);
    if (!existing) {
      newDayRows.push({ marketId, ...aggregate });
    } else {
      // The day already has a scan in the database. Extend its extremes but
      // never move the close backwards from a partial history point.
      dayUpdates.push(prisma.dailySummary.update({
        where: { marketId_itemId_date: { marketId, itemId: aggregate.itemId, date: aggregate.date } },
        data: {
          highPrice: Math.max(existing.highPrice, aggregate.highPrice),
          lowPrice: Math.min(existing.lowPrice, aggregate.lowPrice)
        }
      }));
    }
  }
  if (newDayRows.length > 0) {
    dayUpdates.push(prisma.dailySummary.createMany({ data: newDayRows }));
  }

  const snapshotBatches: Prisma.PrismaPromise<unknown>[] = [];
  for (let start = 0; start < snapshots.length; start += SNAPSHOT_BATCH) {
    snapshotBatches.push(prisma.auctionSnapshot.createMany({ data: snapshots.slice(start, start + SNAPSHOT_BATCH) }));
  }
  return {
    statements: [
      ...(itemCreates.length > 0 ? [prisma.item.createMany({ data: itemCreates })] : []),
      ...snapshotBatches,
      ...dayUpdates
    ],
    timestamps: backfill.timestamps,
    skipped: backfill.skipped
  };
}

// Imports one addon snapshot plus the character's action journal. The
// snapshot is the market observation; the journal is the only clean
// record of what the player actually did. Positions and realized trades
// are rebuilt from the journal on every import, so the terminal never
// accumulates a cached P&L that drifts from the facts.
export async function POST(request: Request) {
  const payload = (await request.json()) as Record<string, unknown>;
  const rawScan = payload.scan ?? payload;
  let scan;
  let series;
  try {
    scan = normalizeAddonScan(rawScan);
    // The series is the addon's own append-only log. A stale or foreign
    // series is simply absent; a malformed one is a code-shape error and
    // must not be misread point by point.
    series = parseAddonSeries(payload.series, { server: scan.server, faction: scan.faction });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  // Validate the journal attribution before any write: a journal that cannot
  // be tied to a character must not leave a half-imported market behind.
  const journalPresent = payload.journal !== undefined && payload.journal !== null;
  if (journalPresent && !scan.character) {
    return NextResponse.json(
      { error: "A journal-bearing scan must name its character; the ledger cannot be attributed" },
      { status: 400 }
    );
  }

  // Market identity lives in the Market row; snapshots reference it and do
  // not duplicate the realm/faction strings.
  const duplicate = await prisma.auctionSnapshot.findFirst({
    where: {
      timestamp: scan.scannedAt,
      market: { is: { realm: scan.server, faction: scan.faction } }
    },
    select: { id: true, marketId: true }
  });
  if (duplicate) {
    // The mailbox and the sell page flush the journal between scans. The
    // snapshot is already imported, but the actions inside it are not: a
    // duplicate timestamp carrying a journal replays the ledger so a
    // confirmed sale reaches the terminal without waiting for the next
    // scan. Scan-only tooling keeps the old "already imported" answer.
    if (!journalPresent) {
      return NextResponse.json({ error: `Scan at ${scan.scannedAt.toISOString()} already imported` }, { status: 409 });
    }
    const book = bookForCharacter(
      parseJournal(payload.journal),
      scan.character ? [scan.server, scan.faction, scan.character].join("|") : null
    );
    const replay = replayJournal(book?.events ?? []);
    // A restart replays the latest scan through this branch. The scans that
    // happened while the watcher was down are still only in the series, so
    // the duplicate import must backfill them too.
    const existingItemIds = await prisma.item.findMany({ select: { itemId: true } });
    const backfill = await buildBackfillStatements(
      scan, series, duplicate.marketId, new Set(existingItemIds.map((row) => row.itemId))
    );
    await prisma.$transaction([
      ...backfill.statements,
      ...journalStatements(replay, duplicate.marketId)
    ]);
    return NextResponse.json({
      duplicate: true,
      journalUpdated: true,
      backfilled: backfill.timestamps.length,
      backfillSkipped: backfill.skipped,
      scannedAt: scan.scannedAt.toISOString(),
      marketId: duplicate.marketId,
      positions: Object.keys(replay.positions).length,
      trades: replay.trades.length,
      journalErrors: replay.errors.length
    });
  }

  // The market's first observation only moves earlier. Persisting it keeps
  // phase age stable when retention later deletes the oldest snapshots.
  const existingMarket = await prisma.market.findUnique({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    select: { firstScanAt: true }
  });
  const firstScanAt = [
    existingMarket?.firstScanAt,
    series?.firstScanAt ? new Date(series.firstScanAt * 1000) : null,
    scan.scannedAt
  ]
    .filter((value): value is Date => value instanceof Date)
    .reduce((earliest, value) => (value < earliest ? value : earliest));

  const market = await prisma.market.upsert({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    create: {
      realm: scan.server,
      faction: scan.faction,
      cash: scan.cash,
      character: scan.character ?? "",
      openedAt: scan.openedAt ? new Date(scan.openedAt * 1000) : null,
      firstScanAt,
      bagSlots: scan.bagSlots
    },
    // A scan-only import carries no character, so it must not erase the one
    // the last journal-bearing scan recorded. An opening time of null means
    // the addon did not report the field (an older version) and must leave a
    // configured anchor alone; 0 means the player cleared it with
    // /wahopen auto and the stored anchor must go too.
    update: {
      cash: scan.cash,
      ...(scan.character ? { character: scan.character } : {}),
      ...(scan.openedAt === null ? {} : {
        openedAt: scan.openedAt > 0 ? new Date(scan.openedAt * 1000) : null
      }),
      firstScanAt,
      // Null means an older addon that did not report bags; keep the last
      // known capacity rather than resetting the core to its fallback.
      ...(scan.bagSlots === null ? {} : { bagSlots: scan.bagSlots })
    }
  });

  // Full-table reads instead of `in` filters: the item table is small and
  // this keeps the statements clear of SQLite's bound-parameter limit even
  // at 100x-scale scans.
  const existingItems = await prisma.item.findMany({
    select: { itemId: true, name: true, quality: true, category: true, subCategory: true, vendorPrice: true }
  });
  const itemDiff = diffScanItems(scan.items, existingItems);
  // Daily OHLC is a price series: demand-only snapshots carry no price.
  const pricedItems = scan.items.filter((item) => item.priced);
  const dayProbe = mergeScanIntoDailySummaries(pricedItems, scan.scannedAt, market.id, []);
  const existingDayRows = await prisma.dailySummary.findMany({
    where: { marketId: market.id, date: dayProbe.date },
    select: { itemId: true, highPrice: true, lowPrice: true }
  });
  const { date, creates, updates } = mergeScanIntoDailySummaries(pricedItems, scan.scannedAt, market.id, existingDayRows);

  const knownItemIds = new Set(existingItems.map((row) => row.itemId));
  for (const create of itemDiff.creates) knownItemIds.add(create.itemId);
  const backfill = await buildBackfillStatements(scan, series, market.id, knownItemIds);

  const book = bookForCharacter(
    parseJournal(payload.journal),
    scan.character ? [scan.server, scan.faction, scan.character].join("|") : null
  );
  // A v4 addon writes the journal global on every load, so a journal-bearing
  // scan is authoritative even when this character has no events yet: an
  // empty book rebuilds an empty ledger instead of leaving a previous
  // character's positions next to this scan's cash. A scan-only payload
  // (tooling) leaves the ledger untouched.
  const replay = journalPresent ? replayJournal(book?.events ?? []) : null;

  // One transaction for the whole import: the snapshot, the backfilled
  // history, the derived daily rows and the journal projection land
  // all-or-nothing.
  const statements: Prisma.PrismaPromise<unknown>[] = [
    ...(itemDiff.creates.length > 0 ? [prisma.item.createMany({ data: itemDiff.creates })] : []),
    ...backfill.statements,
    ...itemDiff.updates.map((update) => prisma.item.update({ where: { itemId: update.itemId }, data: update.data })),
    prisma.auctionSnapshot.createMany({
      data: scan.items.map((item) => ({
        itemId: item.itemId,
        timestamp: scan.scannedAt,
        marketId: market.id,
        priced: item.priced,
        minPrice: item.minPrice,
        marketPrice: item.marketPrice,
        sellPrice: item.sellPrice,
        p5Price: item.p5Price,
        quantity: item.quantity,
        numAuctions: item.numAuctions,
        sellerCount: item.sellerCount,
        sellersInvisible: item.sellersInvisible,
        ownerVisible: item.ownerVisible,
        observationVersion: scan.observationVersion,
        sellerHHI: item.sellerHHI,
        topSellerShare: item.topSellerShare,
        marketType: item.marketType,
        bidOnlyCount: item.bidOnlyCount,
        highestBid: item.highestBid,
        soldProxyLow: item.inferredSoldLow,
        soldProxyHigh: item.inferredSoldHigh,
        flowObserved: item.flowObserved,
        supplyGrowth: item.supplyGrowth,
        historySamples: item.historySamples,
        historySpanHours: item.historySpanHours,
        tierTruncated: item.tierTruncated,
        topTiers: item.tiers,
        expiring: item.expiring
      }))
    }),
    ...(creates.length > 0 ? [prisma.dailySummary.createMany({ data: creates })] : []),
    ...updates.map((update) => prisma.dailySummary.update({
      where: { marketId_itemId_date: { marketId: market.id, itemId: update.itemId, date } },
      data: update.data
    }))
  ];

  if (replay) {
    statements.push(...journalStatements(replay, market.id));
  }

  await prisma.$transaction(statements);

  return NextResponse.json({
    imported: scan.items.length,
    bidOnly: scan.items.filter((item) => item.bidOnlyCount > 0).length,
    // Scans delivered from the series rather than from the current snapshot.
    backfilled: backfill.timestamps.length,
    backfillSkipped: backfill.skipped,
    scannedAt: scan.scannedAt.toISOString(),
    marketId: market.id,
    positions: replay ? Object.keys(replay.positions).length : 0,
    trades: replay ? replay.trades.length : 0,
    journalErrors: replay ? replay.errors.length : 0
  });
}
