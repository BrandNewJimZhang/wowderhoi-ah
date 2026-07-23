import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan } from "@/lib/addon-scan";
import { mergeScanIntoDailySummaries } from "@/lib/daily-summary";
import { diffScanItems } from "@/lib/scan-import";

export async function POST(request: Request) {
  let scan;
  try {
    scan = normalizeAddonScan(await request.json());
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

  // Full-table reads instead of `in` filters: the item table is small and
  // this keeps the statements clear of SQLite's bound-parameter limit even
  // at 100x-scale scans.
  const existingItems = await prisma.item.findMany({ select: { itemId: true, name: true, quality: true, vendorPrice: true } });
  const itemDiff = diffScanItems(scan.items, existingItems);
  const dayProbe = mergeScanIntoDailySummaries(scan.items, scan.scannedAt, []);
  const existingDayRows = await prisma.dailySummary.findMany({
    where: { date: dayProbe.date },
    select: { itemId: true, highPrice: true, lowPrice: true }
  });
  const { date, creates, updates } = mergeScanIntoDailySummaries(scan.items, scan.scannedAt, existingDayRows);

  // One transaction for the whole scan: a single commit instead of one
  // autocommit fsync per item, and the import lands all-or-nothing.
  await prisma.$transaction([
    ...(itemDiff.creates.length > 0 ? [prisma.item.createMany({ data: itemDiff.creates })] : []),
    ...itemDiff.updates.map((update) => prisma.item.update({ where: { itemId: update.itemId }, data: update.data })),
    prisma.auctionSnapshot.createMany({
      data: scan.items.map((item) => ({
        itemId: item.itemId,
        timestamp: scan.scannedAt,
        server: scan.server,
        faction: scan.faction,
        minPrice: item.minPrice,
        marketPrice: item.marketPrice,
        quantity: item.quantity,
        numAuctions: item.numAuctions
      }))
    }),
    ...(creates.length > 0 ? [prisma.dailySummary.createMany({ data: creates })] : []),
    ...updates.map((update) => prisma.dailySummary.update({ where: { itemId_date: { itemId: update.itemId, date } }, data: update.data }))
  ]);

  return NextResponse.json({ imported: scan.items.length, scannedAt: scan.scannedAt.toISOString() });
}
