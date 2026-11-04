import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan } from "@/lib/addon-scan";
import { mergeScanIntoDailySummaries } from "@/lib/daily-summary";
import { diffScanItems } from "@/lib/scan-import";
import { bookForCharacter, parseJournal, replayJournal } from "@/lib/journal";

// Imports one addon snapshot plus the character's action journal. The
// snapshot is the market observation; the journal is the only clean
// record of what the player actually did. Positions and realized trades
// are rebuilt from the journal on every import, so the terminal never
// accumulates a cached P&L that drifts from the facts.
export async function POST(request: Request) {
  const payload = (await request.json()) as Record<string, unknown>;
  const rawScan = payload.scan ?? payload;
  let scan;
  try {
    scan = normalizeAddonScan(rawScan);
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
    select: { id: true }
  });
  if (duplicate) {
    return NextResponse.json({ error: `Scan at ${scan.scannedAt.toISOString()} already imported` }, { status: 409 });
  }

  const market = await prisma.market.upsert({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    create: { realm: scan.server, faction: scan.faction, cash: scan.cash, character: scan.character ?? "" },
    // A scan-only import carries no character, so it must not erase the one
    // the last journal-bearing scan recorded.
    update: { cash: scan.cash, ...(scan.character ? { character: scan.character } : {}) }
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

  // One transaction for the whole import: the snapshot, the derived daily
  // rows and the journal projection land all-or-nothing.
  const statements: Prisma.PrismaPromise<unknown>[] = [
    ...(itemDiff.creates.length > 0 ? [prisma.item.createMany({ data: itemDiff.creates })] : []),
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
        marketType: item.marketType,
        bidOnlyCount: item.bidOnlyCount,
        highestBid: item.highestBid,
        soldProxyLow: item.inferredSoldLow,
        soldProxyHigh: item.inferredSoldHigh,
        supplyGrowth: item.supplyGrowth,
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
    const positions = Object.entries(replay.positions).map(([itemId, position]) => ({
      marketId: market.id,
      itemId: Number(itemId),
      qty: position.qty,
      costBasis: position.cost
    }));
    const trades = replay.trades.map((trade) => ({
      marketId: market.id,
      itemId: trade.itemId ?? 0,
      qty: trade.qty,
      price: trade.price,
      fee: trade.fee,
      pnl: trade.pnl,
      channel: trade.channel,
      inferred: trade.inferred,
      realizedAt: new Date(trade.t * 1000)
    }));
    statements.push(
      prisma.position.deleteMany({ where: { marketId: market.id } }),
      ...(positions.length > 0 ? [prisma.position.createMany({ data: positions })] : []),
      prisma.trade.deleteMany({ where: { marketId: market.id } }),
      ...(trades.length > 0 ? [prisma.trade.createMany({ data: trades })] : [])
    );
  }

  await prisma.$transaction(statements);

  return NextResponse.json({
    imported: scan.items.length,
    bidOnly: scan.items.filter((item) => item.bidOnlyCount > 0).length,
    scannedAt: scan.scannedAt.toISOString(),
    marketId: market.id,
    positions: replay ? Object.keys(replay.positions).length : 0,
    trades: replay ? replay.trades.length : 0,
    journalErrors: replay ? replay.errors.length : 0
  });
}
