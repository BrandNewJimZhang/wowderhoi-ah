import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAddonScan, type AddonScan } from "@/lib/addon-scan";
import { ensureScanItems, scanPlaceholderItem } from "@/lib/scan-import";
import { mergeSeriesByItem, parseAddonSeries, scanSeriesPoints, type AddonSeries } from "@/lib/item-series";
import { buildGenerationPlan, seriesRowsFrom, type DecisionRow } from "@/lib/market-generation";
import { replaceDecisions, replaceSeries, writeGeneration } from "@/lib/import-store";
import { buildCoreInput } from "@/lib/core/from-market";
import { runCore } from "@/lib/core/run-core";
import type { CoreOutput } from "@/lib/core/types";
import type { MarketPhase } from "@/lib/market-rules";
import { decisionIdFor } from "@/lib/decision-id";
import { adoptionTimes, bookForCharacter, parseJournal, replayJournal, replayLedgerRevision, type JournalEvent, type ReplayState } from "@/lib/journal";
import { linkTrades, type AdoptedDecision } from "@/lib/decision-linking";
import { ownSalesFromRows } from "@/lib/own-sales";
import { resolveBudgetCopper, resolvePhaseOverride } from "@/lib/config";
import { pruneAgedRows, pruneGenerations } from "@/lib/retention";
import {
  getGenerationQuotes,
  getGenerationSignals,
  getLedgerRevision,
  getOwnSales,
  getPositions,
  getSeriesForItems
} from "@/lib/repositories";
import type { MarketScope } from "@/lib/market-scope";
import type { SignalItem } from "@/lib/market-data";

function scopeOf(market: {
  id: string; realm: string; faction: string; cash: number; character: string;
  openedAt: Date | null; firstScanAt: Date | null; bagSlots: number | null;
}): MarketScope {
  return {
    id: market.id,
    realm: market.realm,
    faction: market.faction,
    cash: market.cash,
    character: market.character,
    openedAt: market.openedAt,
    firstScanAt: market.firstScanAt,
    bagSlots: market.bagSlots
  };
}

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

// Confirmed auction sales from the replay, the same projection the database
// path uses in getOwnSales.
function ownSalesOf(replay: ReplayState) {
  return ownSalesFromRows(
    replay.trades
      .filter((trade) => trade.channel === "auction" && !trade.inferred && trade.itemId !== null)
      .map((trade) => ({
        itemId: trade.itemId as number,
        qty: trade.qty,
        realizedAt: new Date(trade.t * 1000),
        listedAt: trade.listedAt ? new Date(trade.listedAt * 1000) : null
      }))
  );
}

function decisionRows(
  core: CoreOutput,
  scan: AddonScan,
  adopted: Map<string, Date>
): Array<DecisionRow & { adoptedAt: Date | null }> {
  return core.actions.map((action) => {
    const decisionId = decisionIdFor({
      realm: scan.server,
      faction: scan.faction,
      scannedAt: scan.scannedAt,
      itemId: action.itemId,
      kind: action.kind
    });
    return {
      decisionId,
      itemId: action.itemId,
      kind: action.kind,
      reason: action.reason,
      expectedNet: action.expectedNet,
      fillProb: action.kind === "buy" ? action.fillProb : null,
      fillBasis: action.kind === "buy" ? action.fillBasis : null,
      allocQty: action.kind === "buy" ? action.allocQty : action.qty,
      allocUnitPrice: action.kind === "buy" ? action.allocUnitPrice : action.price,
      adoptedAt: adopted.get(decisionId) ?? null
    };
  });
}

async function adoptedDecisionsFor(
  marketId: string,
  events: readonly JournalEvent[],
  current: DecisionRow[],
  now: Date
): Promise<AdoptedDecision[]> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const stored = await prisma.decision.findMany({
    where: { marketId, adoptedAt: { not: null }, at: { gte: since } },
    select: { decisionId: true, itemId: true, kind: true, adoptedAt: true }
  });
  const adoptions = adoptionTimes(events);
  const byId = new Map<string, AdoptedDecision>();
  for (const row of stored) {
    if (row.decisionId) byId.set(row.decisionId, { decisionId: row.decisionId, itemId: row.itemId, kind: row.kind, adoptedAt: row.adoptedAt });
  }
  for (const row of current) {
    const at = adoptions.get(row.decisionId);
    if (at) byId.set(row.decisionId, { decisionId: row.decisionId, itemId: row.itemId, kind: row.kind, adoptedAt: at });
  }
  return Array.from(byId.values());
}

function journalStatements(
  tx: Prisma.TransactionClient,
  replay: ReplayState,
  marketId: string,
  adopted: readonly AdoptedDecision[]
): Prisma.PrismaPromise<unknown>[] {
  const positions = Object.entries(replay.positions).map(([itemId, position]) => ({
    marketId,
    itemId: Number(itemId),
    qty: position.qty,
    costBasis: position.cost
  }));
  const linked = linkTrades(
    replay.trades
      .filter((trade) => trade.itemId !== null)
      .map((trade) => ({
        itemId: trade.itemId as number,
        realizedAt: new Date(trade.t * 1000),
        qty: trade.qty,
        price: trade.price,
        fee: trade.fee,
        pnl: trade.pnl,
        channel: trade.channel,
        inferred: trade.inferred,
        listedAt: trade.listedAt ? new Date(trade.listedAt * 1000) : null,
        decisionId: null as string | null,
        matchKind: null as string | null
      })),
    adopted
  ).map((trade) => ({
    marketId,
    itemId: trade.itemId,
    qty: trade.qty,
    price: trade.price,
    fee: trade.fee,
    pnl: trade.pnl,
    channel: trade.channel,
    inferred: trade.inferred,
    listedAt: trade.listedAt,
    realizedAt: trade.realizedAt,
    decisionId: trade.decisionId ?? null,
    matchKind: trade.matchKind ?? null
  }));
  return [
    tx.position.deleteMany({ where: { marketId } }),
    ...(positions.length > 0 ? [tx.position.createMany({ data: positions })] : []),
    tx.trade.deleteMany({ where: { marketId } }),
    ...(linked.length > 0 ? [tx.trade.createMany({ data: linked })] : [])
  ];
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
  const journalPresent = payload.journal !== undefined && payload.journal !== null;
  if (journalPresent && !scan.character) {
    return NextResponse.json(
      { error: "A journal-bearing scan must name its character; the ledger cannot be attributed" },
      { status: 400 }
    );
  }
  const book = journalPresent
    ? bookForCharacter(parseJournal(payload.journal), scan.character ? [scan.server, scan.faction, scan.character].join("|") : null)
    : null;
  const replay = journalPresent ? replayJournal(book?.events ?? []) : null;
  const journalEvents = book?.events.length ?? 0;

  const duplicate = await prisma.marketGeneration.findFirst({
    where: {
      scannedAt: scan.scannedAt,
      market: { is: { realm: scan.server, faction: scan.faction } }
    },
    select: { id: true, marketId: true, phase: true, firstScanAt: true, scannedAt: true }
  });
  if (duplicate) {
    if (!journalPresent || !replay) {
      await recordRun({
        marketId: duplicate.marketId, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
        seriesPoints: series?.points.length ?? 0, quotes: 0, journalEvents: 0, journalErrors: 0,
        durationMs: Date.now() - startedAt, status: "duplicate"
      });
      return NextResponse.json({ error: `Scan at ${scan.scannedAt.toISOString()} already imported` }, { status: 409 });
    }
    const market = await prisma.market.findUnique({ where: { id: duplicate.marketId } });
    if (!market) throw new Error(`Market ${duplicate.marketId} disappeared during import`);
    // A duplicate is also the "watcher restarted" path: the addon may carry
    // history the generation does not. Merging is idempotent, and the next
    // scan rebuilds the signals from the longer series.
    const scanSeconds = Math.round(scan.scannedAt.getTime() / 1000);
    const seriesIds = collectSeriesItemIds(scan, series);
    const existingSeries = await getSeriesForItems(market.id, Array.from(seriesIds));
    const mergedSeries = mergeSeriesByItem(
      existingSeries,
      [...(series?.points ?? []), ...scanSeriesPoints(scan)],
      scanSeconds
    );
    const seriesRows = seriesRowsFrom(mergedSeries);
    const seriesPointCount = seriesRows.reduce((sum, row) => sum + row.pointCount, 0);
    const knownItemIds = new Set(
      (await prisma.item.findMany({ select: { itemId: true } })).map((row) => row.itemId)
    );
    const seriesItemCreates = seriesRows
      .filter((row) => !knownItemIds.has(row.itemId))
      .map((row) => scanPlaceholderItem(row.itemId));
    const [storedRows, storedQuotes] = await Promise.all([
      getGenerationSignals(duplicate.id),
      getGenerationQuotes(duplicate.id)
    ]);
    const quoteById = new Map(storedQuotes.map((row) => [row.itemId, row.quote]));
    const pairs = storedRows
      .filter((row) => !row.signal.stale)
      .map((row) => {
        const quote = quoteById.get(row.signal.itemId);
        if (!quote) throw new Error(`Generation ${duplicate.id} has a signal without a quote for ${row.signal.itemId}`);
        return {
          signal: row.signal,
          quote,
          previousAt: row.previousAt === null ? null : new Date(row.previousAt * 1000)
        };
      });
    const ownSales = ownSalesOf(replay);
    // Only the newest generations keep materialised signals. A replayed
    // scan older than that window has no rows left; recomputing its core
    // would overwrite the generation with an empty evaluation and delete
    // the decisions the review still reads. Merge the series and ledger,
    // and leave a stripped generation alone.
    const core = storedRows.length > 0
      ? runCore(buildCoreInput(pairs, {
          now: duplicate.scannedAt,
          phase: duplicate.phase as MarketPhase,
          firstScanAt: duplicate.firstScanAt ?? market.firstScanAt ?? undefined,
          positions: replay.positions,
          ownSales,
          budgetCopper: resolveBudgetCopper(),
          cashCopper: market.cash,
          bagSlots: market.bagSlots ?? undefined
        }))
      : null;
    const adoptions = adoptionTimes(book?.events ?? []);
    const existingDecisions = await prisma.decision.findMany({
      where: { generationId: duplicate.id },
      select: { decisionId: true, adoptedAt: true }
    });
    const previousAdoption = new Map(
      existingDecisions.filter((row) => row.decisionId).map((row) => [row.decisionId as string, row.adoptedAt])
    );
    const rows = core
      ? decisionRows(core, scan, adoptions).map((row) => ({
          ...row,
          adoptedAt: row.adoptedAt ?? previousAdoption.get(row.decisionId) ?? null
        }))
      : [];
    const adopted = core ? await adoptedDecisionsFor(market.id, book?.events ?? [], rows, scan.scannedAt) : [];
    const ledgerRevision = replayLedgerRevision(replay);
    await prisma.$transaction(async (tx) => {
      if (core) {
        await tx.marketGeneration.update({
          where: { id: duplicate.id },
          data: {
            core: core as unknown as Prisma.InputJsonValue,
            ledgerRevision
          }
        });
        await replaceDecisions(tx, duplicate.id, market.id, scan.scannedAt, duplicate.phase, rows);
      }
      if (seriesItemCreates.length > 0) await tx.item.createMany({ data: seriesItemCreates });
      await replaceSeries(tx, market.id, seriesRows);
      const seriesFirst = series?.firstScanAt ? new Date(series.firstScanAt * 1000) : null;
      if (seriesFirst && (!market.firstScanAt || seriesFirst < market.firstScanAt)) {
        await tx.market.update({ where: { id: market.id }, data: { firstScanAt: seriesFirst } });
      }
      const statements = journalStatements(tx, replay, market.id, adopted);
      for (const statement of statements) await statement;
    }, { timeout: 60_000 });
    await recordRun({
      marketId: market.id, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: seriesPointCount, quotes: 0, journalEvents,
      journalErrors: replay.errors.length, durationMs: Date.now() - startedAt, status: "duplicate"
    });
    return NextResponse.json({
      duplicate: true,
      journalUpdated: true,
      skippedItems: scan.skippedItems,
      seriesPoints: seriesPointCount,
      scannedAt: scan.scannedAt.toISOString(),
      marketId: market.id,
      positions: Object.keys(replay.positions).length,
      trades: replay.trades.length,
      journalErrors: replay.errors.length
    });
  }

  const existingMarket = await prisma.market.findUnique({
    where: { realm_faction: { realm: scan.server, faction: scan.faction } },
    select: { firstScanAt: true }
  });
  const seriesFirst = series?.firstScanAt ? new Date(series.firstScanAt * 1000) : null;
  const firstScanAt = [existingMarket?.firstScanAt, seriesFirst, scan.scannedAt]
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
    update: {
      cash: scan.cash,
      ...(scan.character ? { character: scan.character } : {}),
      ...(scan.openedAt === null ? {} : {
        openedAt: scan.openedAt > 0 ? new Date(scan.openedAt * 1000) : null
      }),
      firstScanAt,
      ...(scan.bagSlots === null ? {} : { bagSlots: scan.bagSlots })
    }
  });

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

    // The addon series can name items that were never in an imported scan
    // (they were listed earlier in the day and dropped out). The series row
    // has a foreign key to Item, so those ids need a placeholder before the
    // history can land. They stay scan-owned and are never signalled.
    const seriesIds = collectSeriesItemIds(scan, series, previousQuotes.map((row) => row.itemId));
    for (const itemId of seriesIds) {
      if (itemsById.has(itemId)) continue;
      const create = scanPlaceholderItem(itemId);
      itemDiff.creates.push(create);
      itemsById.set(itemId, signalItem({ ...create, iconId: null }));
    }
    const existingSeries = await getSeriesForItems(market.id, Array.from(seriesIds));

    const scope = scopeOf(market);
    const positions = replay ? replay.positions : await getPositions(scope);
    const ownSales = replay ? ownSalesOf(replay) : await getOwnSales(scope);
    const ledgerRevision = replay ? replayLedgerRevision(replay) : await getLedgerRevision(scope);

    const plan = buildGenerationPlan({
      scan,
      series,
      items: itemsById,
      existingSeries,
      previous: previous ? { scannedAt: previous.scannedAt, quotes: previousRefs } : null,
      openedAt: market.openedAt,
      firstScanAt: market.firstScanAt,
      positions,
      ownSales,
      budgetCopper: resolveBudgetCopper(),
      phaseOverride: resolvePhaseOverride()
    });

    const adoptions = adoptionTimes(book?.events ?? []);
    const planDecisions = plan.decisions.map((row) => ({
      ...row,
      adoptedAt: adoptions.get(row.decisionId) ?? null
    }));
    const adopted = await adoptedDecisionsFor(market.id, book?.events ?? [], planDecisions, scan.scannedAt);

    await prisma.$transaction(async (tx) => {
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
      await writeGeneration(tx, market.id, plan, planDecisions, ledgerRevision);
      if (replay) {
        const statements = journalStatements(tx, replay, market.id, adopted);
        for (const statement of statements) await statement;
      }
    }, { timeout: 120_000 });

    await pruneGenerations(market.id);
    await pruneAgedRows();
    await recordRun({
      marketId: market.id, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: plan.seriesPointCount, quotes: plan.quotes.length, journalEvents,
      journalErrors: replay?.errors.length ?? 0, durationMs: Date.now() - startedAt, status: "ok"
    });
    return NextResponse.json({
      imported: scan.items.length,
      skippedItems: scan.skippedItems,
      bidOnly: scan.items.filter((item) => item.bidOnlyCount > 0).length,
      seriesPoints: plan.seriesPointCount,
      quotes: plan.quotes.length,
      signals: plan.signals.length,
      decisions: planDecisions.length,
      stale: plan.staleCount,
      phase: plan.phase,
      scannedAt: scan.scannedAt.toISOString(),
      marketId: market.id,
      positions: replay ? Object.keys(replay.positions).length : 0,
      trades: replay ? replay.trades.length : 0,
      journalErrors: replay ? replay.errors.length : 0
    });
  } catch (error) {
    await recordRun({
      marketId: market.id, scannedAt: scan.scannedAt, source, scanItems: scan.items.length,
      seriesPoints: series?.points.length ?? 0, quotes: 0, journalEvents,
      journalErrors: replay?.errors.length ?? 0, durationMs: Date.now() - startedAt,
      status: "error", error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
