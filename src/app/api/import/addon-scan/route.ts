import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan } from "@/lib/addon-scan";
import { mergeScanIntoDailySummaries } from "@/lib/daily-summary";
import { diffScanItems } from "@/lib/scan-import";
import { parseJournal, replayJournal } from "@/lib/journal";

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

  const duplicate = await prisma.auctionSnapshot.findFirst({
    where: { timestamp: scan.scannedAt, server: scan.server, faction: scan.faction },
    select: { id: true }
  });
  if (duplicate) {
    return NextResponse.json({ error: `Scan at ${scan.scannedAt.toISOString()} already imported` }, { status: 409 });
  }

  const market = await prisma.market.upsert({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    create: { realm: scan.server, faction: scan.faction },
    update: { cash: scan.cash }
  });

  // Full-table reads instead of `in` filters: the item table is small and
  // this keeps the statements clear of SQLite's bound-parameter limit even
  // at 100x-scale scans.
  const existingItems = await prisma.item.findMany({
    select: { itemId: true, name: true, quality: true, category: true, subCategory: true, vendorPrice: true }
  });
  const itemDiff = diffScanItems(scan.items, existingItems);
  const dayProbe = mergeScanIntoDailySummaries(scan.items, scan.scannedAt, market.id, []);
  const existingDayRows = await prisma.dailySummary.findMany({
    where: { marketId: market.id, date: dayProbe.date },
    select: { itemId: true, highPrice: true, lowPrice: true }
  });
  const { date, creates, updates } = mergeScanIntoDailySummaries(scan.items, scan.scannedAt, market.id, existingDayRows);

  const rawItems = ((rawScan as Record<string, unknown>).items ?? {}) as Record<string, unknown>;
  const books = parseJournal(payload.journal);
  const bookKey = [scan.server, scan.faction, scan.character].join("|");
  const book = books.find((candidate) => candidate.key === bookKey)
    ?? books.find((candidate) => candidate.key.startsWith(`${scan.server}|${scan.faction}|`))
    ?? null;
  const replay = book ? replayJournal(book.events, market.id) : null;

  // One transaction for the whole import: the snapshot, the derived daily
  // rows and the journal projection land all-or-nothing.
  const statements: Prisma.PrismaPromise<unknown>[] = [
    ...(itemDiff.creates.length > 0 ? [prisma.item.createMany({ data: itemDiff.creates })] : []),
    ...itemDiff.updates.map((update) => prisma.item.update({ where: { itemId: update.itemId }, data: update.data })),
    prisma.auctionSnapshot.createMany({
      data: scan.items.map((item) => ({
        itemId: item.itemId,
        timestamp: scan.scannedAt,
        server: scan.server,
        faction: scan.faction,
        marketId: market.id,
        minPrice: item.minPrice,
        marketPrice: item.marketPrice,
        sellPrice: item.sellPrice,
        p5Price: item.p5Price,
        quantity: item.quantity,
        numAuctions: item.numAuctions,
        sellerCount: item.sellerCount,
        sellersInvisible: item.sellersInvisible,
        bidOnlyCount: item.bidOnlyCount,
        soldProxyLow: item.inferredSoldLow,
        soldProxyHigh: item.inferredSoldHigh,
        supplyGrowth: item.supplyGrowth,
        topTiers: item.tiers,
        expiring: item.expiring,
        rawPayload: (rawItems[String(item.itemId)] ?? undefined) as Prisma.InputJsonValue | undefined
      }))
    }),
    ...(creates.length > 0 ? [prisma.dailySummary.createMany({ data: creates })] : []),
    ...updates.map((update) => prisma.dailySummary.update({
      where: { marketId_itemId_date: { marketId: market.id, itemId: update.itemId, date } },
      data: update.data
    }))
  ];

  if (replay) {
    const positions = Object.entries(replay.positions).map(([itemId, position]) => {
      const lots = replay.lots[Number(itemId)] ?? [];
      const openedAt = lots[0]?.at ? new Date(lots[0].at * 1000) : scan.scannedAt;
      return {
        marketId: market.id,
        itemId: Number(itemId),
        qty: position.qty,
        costBasis: position.cost,
        openedAt
      };
    });
    const trades = replay.trades.map((trade) => ({
      marketId: market.id,
      itemId: trade.itemId ?? 0,
      qty: trade.qty,
      price: trade.price,
      fee: trade.fee,
      basis: trade.basis,
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
    bidOnly: scan.bids.length,
    scannedAt: scan.scannedAt.toISOString(),
    marketId: market.id,
    positions: replay ? Object.keys(replay.positions).length : 0,
    trades: replay ? replay.trades.length : 0,
    journalErrors: replay ? replay.errors.length : 0
  });
}
