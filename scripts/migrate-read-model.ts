// One-off migration from the snapshot read model to generations + a
// terminal-owned series. Reconstructs the series from the retained
// snapshots and daily summaries, merges the addon's own series when the
// SavedVariables file is available, and materialises one generation from
// each market's newest snapshot.
//
// Idempotent: a market that already has a generation at its newest
// snapshot keeps it; the series is rebuilt from the same sources and the
// same merge.
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { parseSavedVariables, type AddonScan, type AddonScanItem } from "@/lib/addon-scan";
import { placeholderItemName } from "@/lib/item-name";
import { arraysToSeries, parseAddonSeries, mergeSeries, seriesToArrays, type AddonSeries, type SeriesPoint } from "@/lib/item-series";
import { buildGenerationPlan } from "@/lib/market-generation";
import { writeGeneration, chunks } from "@/lib/import-store";
import { getLedgerRevision, getOwnSales, getPositions } from "@/lib/repositories";
import { resolveBudgetCopper } from "@/lib/config";
import type { MarketScope } from "@/lib/market-scope";

process.loadEnvFile();

function utcDay(t: number): number {
  const date = new Date(t * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

function tiersOf(raw: unknown): AddonScanItem["tiers"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      return typeof row.p === "number" && typeof row.q === "number" && row.p > 0 && row.q > 0
        ? { p: row.p, q: row.q }
        : null;
    })
    .filter((entry): entry is { p: number; q: number } => entry !== null);
}

function expiringOf(raw: unknown): AddonScanItem["expiring"] {
  const row = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const value = (key: string) => typeof row[key] === "number" ? Number(row[key]) : 0;
  return { soon: value("soon"), mid: value("mid"), late: value("late") };
}

function addonSeriesFor(path: string | undefined): Map<string, AddonSeries> {
  const out = new Map<string, AddonSeries>();
  if (!path) return out;
  const parsed = parseSavedVariables(readFileSync(path, "utf8"));
  const root = parsed.WoWderhoiAH_Series;
  if (typeof root !== "object" || root === null) return out;
  const markets = (root as Record<string, unknown>).markets;
  if (typeof markets !== "object" || markets === null) return out;
  for (const key of Object.keys(markets as Record<string, unknown>)) {
    const [server, faction] = key.split("|");
    if (!server || !faction) continue;
    const series = parseAddonSeries(root, { server, faction });
    if (series) out.set(key, series);
  }
  return out;
}

async function main() {
  const addonSeries = addonSeriesFor(process.env.AQT_SAVEDVARS_PATH);
  const markets = await prisma.market.findMany();
  const knownItemIds = new Set((await prisma.item.findMany({ select: { itemId: true } })).map((row) => row.itemId));
  let generations = 0;
  let seriesRows = 0;

  for (const market of markets) {
    const snapshots = await prisma.auctionSnapshot.findMany({
      where: { marketId: market.id },
      orderBy: { timestamp: "asc" }
    });
    const dailies = await prisma.dailySummary.findMany({ where: { marketId: market.id } });
    const existingRows = await prisma.itemSeries.findMany({ where: { marketId: market.id } });
    if (snapshots.length === 0 && dailies.length === 0 && existingRows.length === 0) continue;

    const latestAt = snapshots.at(-1)?.timestamp ?? market.firstScanAt ?? new Date();
    const latestSeconds = Math.round(latestAt.getTime() / 1000);
    const snapshotDays = new Set<string>();
    const legacy = new Map<number, SeriesPoint[]>();
    for (const row of snapshots) {
      if (!row.priced || row.sellPrice <= 0) continue;
      const t = Math.round(row.timestamp.getTime() / 1000);
      snapshotDays.add(`${row.itemId}|${utcDay(t)}`);
      const points = legacy.get(row.itemId) ?? [];
      points.push({
        t,
        minPrice: row.minPrice > 0 ? row.minPrice : row.sellPrice,
        sellPrice: row.sellPrice,
        quantity: row.quantity,
        numAuctions: row.numAuctions,
        event: false
      });
      legacy.set(row.itemId, points);
    }
    for (const row of dailies) {
      if (row.closePrice <= 0) continue;
      const t = Math.round(row.date.getTime() / 1000);
      if (snapshotDays.has(`${row.itemId}|${utcDay(t)}`)) continue;
      const points = legacy.get(row.itemId) ?? [];
      points.push({
        t,
        minPrice: row.lowPrice > 0 ? row.lowPrice : row.closePrice,
        sellPrice: row.closePrice,
        quantity: row.volume,
        numAuctions: 0,
        event: false
      });
      legacy.set(row.itemId, points);
    }

    const incoming = addonSeries.get(`${market.realm}|${market.faction}`);
    const incomingByItem = new Map<number, SeriesPoint[]>();
    for (const point of incoming?.points ?? []) {
      const list = incomingByItem.get(point.itemId) ?? [];
      list.push(point);
      incomingByItem.set(point.itemId, list);
    }

    const existingById = new Map(existingRows.map((row) => [row.itemId, row.points]));
    const merged = new Map<number, SeriesPoint[]>();
    const ids = new Set<number>([...legacy.keys(), ...existingById.keys(), ...incomingByItem.keys()]);
    for (const itemId of ids) {
      const existing = existingById.has(itemId) ? arraysToSeries(existingById.get(itemId)) : [];
      const first = mergeSeries(existing, legacy.get(itemId) ?? [], latestSeconds);
      const points = mergeSeries(first, incomingByItem.get(itemId) ?? [], latestSeconds);
      if (points.length > 0) merged.set(itemId, points);
    }
    seriesRows += merged.size;
    // The addon series names items that no imported scan ever carried (they
    // were listed earlier and dropped out). The series row has a foreign key
    // to Item, so create the same placeholder the live import would.
    const placeholderRows = Array.from(merged.keys())
      .filter((itemId) => !knownItemIds.has(itemId))
      .map((itemId) => ({
        itemId,
        name: placeholderItemName(itemId),
        quality: "unknown",
        category: "unknown",
        subCategory: "unknown",
        vendorPrice: null,
        catalogSource: "scan"
      }));
    for (const row of placeholderRows) knownItemIds.add(row.itemId);

    const generationExists = await prisma.marketGeneration.findFirst({
      where: { marketId: market.id, scannedAt: latestAt },
      select: { id: true }
    });

    if (!generationExists && snapshots.length > 0) {
      const items = await prisma.item.findMany();
      const itemsById = new Map(items.map((row) => [row.itemId, row]));
      const latestRows = snapshots.filter((row) => row.timestamp.getTime() === latestAt.getTime());
      const scanItems: AddonScanItem[] = latestRows.map((row) => {
        const item = itemsById.get(row.itemId);
        if (!item) throw new Error(`Snapshot references item ${row.itemId} without an Item row`);
        const marketType = row.marketType === "commodity" || row.marketType === "item" ? row.marketType : null;
        return {
          itemId: row.itemId,
          name: item.name,
          quality: item.quality,
          category: item.category,
          subCategory: item.subCategory,
          marketType,
          priced: row.priced,
          minPrice: row.minPrice,
          marketPrice: row.marketPrice,
          sellPrice: row.sellPrice,
          p5Price: row.p5Price,
          quantity: row.quantity,
          numAuctions: row.numAuctions,
          sellerCount: row.sellerCount,
          sellersInvisible: row.sellersInvisible,
          ownerVisible: row.ownerVisible,
          sellerHHI: row.sellerHHI,
          topSellerShare: row.topSellerShare,
          bidOnlyCount: row.bidOnlyCount,
          highestBid: row.highestBid,
          inferredSoldLow: row.soldProxyLow,
          inferredSoldHigh: row.soldProxyHigh,
          flowObserved: row.flowObserved,
          supplyGrowth: row.supplyGrowth,
          historySamples: row.historySamples,
          historySpanHours: row.historySpanHours,
          vendorPrice: item.vendorPrice ?? 0,
          tiers: tiersOf(row.topTiers),
          tierTruncated: row.tierTruncated,
          expiring: expiringOf(row.expiring)
        };
      });
      const scan: AddonScan = {
        scannedAt: latestAt,
        server: market.realm,
        faction: market.faction,
        character: market.character || null,
        cash: market.cash,
        openedAt: market.openedAt ? Math.round(market.openedAt.getTime() / 1000) : null,
        bagSlots: market.bagSlots,
        observationVersion: latestRows.find((row) => row.observationVersion !== null)?.observationVersion ?? null,
        skippedItems: 0,
        items: scanItems
      };
      const signalItems = new Map(latestRows.map((row) => {
        const item = itemsById.get(row.itemId)!;
        return [row.itemId, {
          itemId: item.itemId,
          name: item.name,
          quality: item.quality,
          category: item.category,
          subCategory: item.subCategory,
          vendorPrice: item.vendorPrice,
          iconId: item.iconId
        }] as const;
      }));
      const scope: MarketScope = {
        id: market.id,
        realm: market.realm,
        faction: market.faction,
        cash: market.cash,
        character: market.character,
        openedAt: market.openedAt,
        firstScanAt: market.firstScanAt,
        bagSlots: market.bagSlots
      };
      const plan = buildGenerationPlan({
        scan,
        series: incoming ?? null,
        items: signalItems,
        existingSeries: Array.from(merged.entries()).map(([itemId, points]) => ({ itemId, points })),
        previous: null,
        openedAt: market.openedAt,
        firstScanAt: market.firstScanAt ?? snapshots[0].timestamp,
        positions: await getPositions(scope),
        ownSales: await getOwnSales(scope),
        budgetCopper: resolveBudgetCopper(),
        phaseOverride: null
      });
      const ledgerRevision = await getLedgerRevision(scope);
      await prisma.$transaction(async (tx) => {
        if (placeholderRows.length > 0) await tx.item.createMany({ data: placeholderRows });
        await writeGeneration(
          tx,
          market.id,
          plan,
          plan.decisions.map((row) => ({ ...row, adoptedAt: null })),
          ledgerRevision
        );
      }, { timeout: 120_000 });
      generations += 1;
      console.log(
        `${market.realm}|${market.faction}: generation ${latestAt.toISOString()} `
        + `(${plan.signals.length} signals, ${plan.series.length} series, phase ${plan.phase})`
      );
    } else {
      // No generation to write (or it already exists): persist the merged
      // series on its own so a rerun still repairs history.
      await prisma.$transaction(async (tx) => {
        if (placeholderRows.length > 0) await tx.item.createMany({ data: placeholderRows });
        await tx.itemSeries.deleteMany({ where: { marketId: market.id } });
        for (const batch of chunks(Array.from(merged.entries()), 500)) {
          await tx.itemSeries.createMany({
            data: batch.map(([itemId, points]) => ({
              marketId: market.id,
              itemId,
              firstAt: new Date(points[0].t * 1000),
              lastAt: new Date(points[points.length - 1].t * 1000),
              pointCount: points.length,
              points: seriesToArrays(points)
            }))
          });
        }
      });
    }
  }

  // Legacy scan-owned rows conflated "not loaded" with "unsellable".
  const relabelled = await prisma.$executeRaw`
    UPDATE "Item" SET vendor_price = NULL
    WHERE catalog_source = 'scan' AND category = 'unknown' AND vendor_price = 0
  `;
  console.log(`Wrote ${generations} generations and ${seriesRows} item series; relabelled ${Number(relabelled)} unknown vendor prices.`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
