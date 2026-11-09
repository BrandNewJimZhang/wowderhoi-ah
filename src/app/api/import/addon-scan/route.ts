import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan, type AddonScan } from "@/lib/addon-scan";
import { ensureScanItems, scanPlaceholderItem } from "@/lib/scan-import";
import { parseAddonSeries, type AddonSeries } from "@/lib/item-series";
import { buildGenerationPlan } from "@/lib/market-generation";
import { writeGeneration } from "@/lib/import-store";
import { refreshHoldings } from "@/lib/state-import";
import { resolveBudgetCopper, resolvePhaseOverride } from "@/lib/config";
import { pruneAgedRows, pruneGenerations } from "@/lib/retention";
import {
  getGenerationQuotes,
  getOwnSales,
  getPositions,
  getSeriesForItems
} from "@/lib/repositories";
import type { MarketScope } from "@/lib/market-scope";
import type { SignalItem } from "@/lib/market-data";

function signalItem(row: {
  itemId: number; name: string; quality: string; category: string;
  subCategory: string; vendorPrice: number | null; iconId: number | null;
}): SignalItem {
  return {
    itemId: row.itemId,
    name: row.name,
    quality: row.quality,
    category: row.category,
    subCategory: row.subCategory,
    vendorPrice: row.vendorPrice,
    iconId: row.iconId
  };
}

// Every item whose series the import must load or replace: this scan's
// priced rows, the addon series, plus whatever the caller already needs.
function collectSeriesItemIds(scan: AddonScan, series: AddonSeries | null, extra: readonly number[] = []): Set<number> {
  const ids = new Set<number>(extra);
  for (const item of scan.items) if (item.priced) ids.add(item.itemId);
  for (const point of series?.points ?? []) ids.add(point.itemId);
  return ids;
}

async function recordRun(data: {
  marketId: string;
  scannedAt: Date;
  source: string;
  scanItems: number;
  seriesPoints: number;
  quotes: number;
  journalEvents: number;
  journalErrors: number;
  durationMs: number;
  status: string;
  error?: string;
}): Promise<void> {
  try {
    await prisma.importRun.create({ data });
  } catch (error) {
    // The import itself already committed. A diagnostics row must not turn
    // a successful import into a failed request.
    console.error("Failed to record import run:", error);
  }
}

// A scan observes cash and free slots but not the bag contents. It may
// update the two fields it observed; it must never rewrite the coverage map
// or the revision the estate publisher owns. Two writers incrementing one
// counter would let the terminal drift ahead of the addon and ignore every
// later push as "older".
async function recordScanState(
  tx: Prisma.TransactionClient,
  marketId: string,
  scan: AddonScan,
  observedAt: Date
): Promise<number> {
  if (!scan.character) return 0;
  const scope = `character:${scan.character}`;
  const existing = await tx.estate.findUnique({
    where: { marketId_scope: { marketId, scope } },
    select: { id: true, revision: true, cash: true, freeSlots: true, observedAt: true }
  });
  if (!existing) {
    const created = await tx.estate.create({
      data: {
        marketId,
        scope,
        // Revision 0 is the scan's cash/slot-only seed. The first pushed
        // estate revision is 1, so it replaces this seed instead of being
        // ignored as an older document.
        revision: 0,
        observedAt,
        cash: scan.cash,
        freeSlots: scan.bagSlots,
        // Character-scoped coverage only. Own postings and the account
        // bank live on the account scope; a character row that claimed
        // them would be a second, unread copy of that coverage map.
        coverage: {
          carried: "unobserved",
          bank: "unobserved",
          mail: "unobserved",
          money: "observed"
        }
      }
    });
    return created.revision;
  }
  // A real-time estate observation newer than the scan already knows the
  // purse; the scan's older snapshot must not move it backwards.
  if (existing.observedAt > observedAt) return existing.revision;
  if (existing.cash === scan.cash
    && (scan.bagSlots === null || existing.freeSlots === scan.bagSlots)) {
    return existing.revision;
  }
  // The revision and the observation time belong to the estate publisher.
  // A scan writes the two fields it observed and keeps both: moving
  // observedAt here would mix two clocks and make a real estate document
  // published before the scan look older than it, so the import would
  // reject a newer revision.
  await tx.estate.update({
    where: { id: existing.id },
    data: {
      cash: scan.cash,
      ...(scan.bagSlots === null ? {} : { freeSlots: scan.bagSlots })
    }
  });
  return existing.revision;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const payload = (await request.json()) as Record<string, unknown>;
  const rawScan = payload.scan ?? payload;
  const source = typeof payload.source === "string" ? payload.source : "api";
  let scan: AddonScan;
  let series: AddonSeries | null;
  try {
    scan = normalizeAddonScan(rawScan);
    series = parseAddonSeries(payload.series, { server: scan.server, faction: scan.faction });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const duplicate = await prisma.marketGeneration.findFirst({
    where: {
      scannedAt: scan.scannedAt,
      market: { is: { realm: scan.server, faction: scan.faction } }
    },
    select: { id: true, marketId: true }
  });
  if (duplicate) {
    // The scan is an immutable observation. A newer journal or estate is
    // applied by /api/import/addon-state; rewriting the generation here
    // would change the identity a decision was already written under.
    await recordRun({
      marketId: duplicate.marketId, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: series?.points.length ?? 0, quotes: 0, journalEvents: 0, journalErrors: 0,
      durationMs: Date.now() - startedAt, status: "duplicate"
    });
    return NextResponse.json({ error: `Scan at ${scan.scannedAt.toISOString()} already imported` }, { status: 409 });
  }

  // Reserve the market row before planning, but leave the page inputs to the
  // import transaction: a failed import must not move the phase anchor.
  const market = await prisma.market.upsert({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    create: { realm: scan.server, faction: scan.faction },
    update: {},
    select: {
      id: true, openedAt: true, firstScanAt: true, dataVersion: true
    }
  });
  const seriesFirst = series?.firstScanAt ? new Date(series.firstScanAt * 1000) : null;
  const firstScanAt = [market.firstScanAt, seriesFirst, scan.scannedAt]
    .filter((value): value is Date => value instanceof Date)
    .reduce((earliest, value) => (value < earliest ? value : earliest));
  const openedAt = scan.openedAt === null
    ? market.openedAt
    : scan.openedAt > 0 ? new Date(scan.openedAt * 1000) : null;
  const character = scan.character || "";
  let estateRevision = 0;

  try {
    const existingItems = await prisma.item.findMany({
      select: {
        itemId: true, name: true, quality: true, category: true, subCategory: true,
        vendorPrice: true, iconId: true, catalogSource: true
      }
    });
    const itemDiff = ensureScanItems(scan.items, existingItems);
    const itemsById = new Map<number, SignalItem>();
    for (const row of existingItems) itemsById.set(row.itemId, signalItem(row));
    for (const row of itemDiff.creates) itemsById.set(row.itemId, signalItem({ ...row, iconId: null }));
    for (const row of scan.items) {
      if (!itemsById.has(row.itemId)) throw new Error(`Scan item ${row.itemId} has no Item row`);
    }

    const previous = await prisma.marketGeneration.findFirst({
      where: { marketId: market.id, scannedAt: { lt: scan.scannedAt } },
      orderBy: { scannedAt: "desc" },
      select: { id: true, scannedAt: true }
    });
    const previousQuotes = previous ? await getGenerationQuotes(previous.id) : [];
    const previousRefs = previousQuotes.map((row) => {
      const item = itemsById.get(row.itemId);
      if (!item) throw new Error(`Previous generation references item ${row.itemId} without a row`);
      return { item, quote: row.quote };
    });

    const seriesIds = collectSeriesItemIds(scan, series, previousQuotes.map((row) => row.itemId));
    for (const itemId of seriesIds) {
      if (itemsById.has(itemId)) continue;
      const create = scanPlaceholderItem(itemId);
      itemDiff.creates.push(create);
      itemsById.set(itemId, signalItem({ ...create, iconId: null }));
    }
    const existingSeries = await getSeriesForItems(market.id, Array.from(seriesIds));

    // The core's sell action reads the character's sellable stock, not the
    // scan's frozen cash. Both come from the state read model.
    const plannedScope: MarketScope = {
      id: market.id,
      realm: scan.server,
      faction: scan.faction,
      cash: scan.cash,
      character,
      bagSlots: scan.bagSlots,
      estateRevision,
      openedAt,
      firstScanAt,
      dataVersion: market.dataVersion
    };
    const { plan, positionCount } = await prisma.$transaction(async (tx) => {
      // The scanned cash and free slots commit with the observation. The
      // scan may not rewrite the coverage map the estate publisher owns.
      estateRevision = await recordScanState(tx, market.id, scan, scan.scannedAt);
      await tx.market.update({
        where: { id: market.id },
        data: {
          openedAt,
          firstScanAt,
          dataVersion: { increment: 1 }
        }
      });
      if (itemDiff.creates.length > 0) {
        await tx.item.createMany({
          data: itemDiff.creates.map((row) => ({
            itemId: row.itemId,
            name: row.name,
            quality: row.quality,
            category: row.category,
            subCategory: row.subCategory,
            vendorPrice: row.vendorPrice,
            catalogSource: row.catalogSource
          }))
        });
      }
      for (const update of itemDiff.updates) {
        await tx.item.update({ where: { itemId: update.itemId }, data: update.data });
      }
      // The scan names the active character. Account bank and own postings
      // move to that character's holding row and leave the previous one.
      // The plan below reads those holdings, so the move must happen first;
      // otherwise a character's first scan would size sells from the
      // previous character's account-scoped stock. A legacy scan without a
      // character must fall back to the same rule the pages use, not pass
      // an empty name that no holding row can match.
      await refreshHoldings(tx, market.id, character || undefined);
      plannedScope.estateRevision = estateRevision;
      const positions = await getPositions(plannedScope, tx);
      const ownSales = await getOwnSales(plannedScope, scan.scannedAt, tx);
      const positionCount = Object.keys(positions).length;
      const plan = buildGenerationPlan({
        scan,
        series,
        items: itemsById,
        existingSeries,
        previous: previous ? { scannedAt: previous.scannedAt, quotes: previousRefs } : null,
        openedAt,
        firstScanAt,
        positions,
        ownSales,
        budgetCopper: resolveBudgetCopper(),
        phaseOverride: resolvePhaseOverride(),
        freeSlots: plannedScope.bagSlots ?? undefined
      });
      // Decisions belong to the game's plan, not to the scan observation.
      // Writing scan-time rows under the old timestamp identity would give
      // the same recommendation two ids and let calibration count it twice.
      await writeGeneration(tx, market.id, plan, []);
      return { plan, positionCount };
    }, { timeout: 120_000 });

    await pruneGenerations(market.id);
    await pruneAgedRows();
    await recordRun({
      marketId: market.id, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: plan.seriesPointCount, quotes: plan.quotes.length, journalEvents: 0,
      journalErrors: 0, durationMs: Date.now() - startedAt, status: "ok"
    });
    return NextResponse.json({
      imported: scan.items.length,
      skippedItems: scan.skippedItems,
      bidOnly: scan.items.filter((item) => item.bidOnlyCount > 0).length,
      seriesPoints: plan.seriesPointCount,
      quotes: plan.quotes.length,
      signals: plan.signals.length,
      decisions: 0,
      stale: plan.staleCount,
      phase: plan.phase,
      scannedAt: scan.scannedAt.toISOString(),
      marketId: market.id,
      positions: positionCount,
      estateRevision
    });
  } catch (error) {
    await recordRun({
      marketId: market.id, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: series?.points.length ?? 0, quotes: 0, journalEvents: 0,
      journalErrors: 0, durationMs: Date.now() - startedAt,
      status: "error", error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
