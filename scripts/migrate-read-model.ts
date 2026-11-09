// One-off migration from the snapshot read model to generations + a
// terminal-owned series. Reconstructs the series from the retained
// snapshots and daily summaries, merges the addon's own series when the
// SavedVariables file is available, and materialises one generation from
// each market's newest snapshot.
//
// The legacy tables are read through raw SQL and held in memory before the
// Prisma schema is pushed: `db push` drops every table the schema no longer
// declares, so pushing first would erase the very history this script
// exists to import. A database that never had them is the no-op case.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { parseSavedVariables, type AddonScan, type AddonScanItem } from "@/lib/addon-scan";
import { arraysToSeries, parseAddonSeries, mergeSeries, mergeSeriesByItem, type AddonSeries, type SeriesPoint } from "@/lib/item-series";
import { buildGenerationPlan, seriesRowsFrom } from "@/lib/market-generation";
import { scanPlaceholderItem } from "@/lib/scan-import";
import { SCAN_SOURCE } from "@/lib/item-catalog";
import { writeGeneration, replaceSeries } from "@/lib/import-store";
import { getOwnSales, getPositions } from "@/lib/repositories";
import { resolveBudgetCopper } from "@/lib/config";
import type { MarketScope } from "@/lib/market-scope";

process.loadEnvFile();

type LegacySnapshot = {
  marketId: string;
  itemId: number;
  timestamp: Date;
  priced: boolean;
  minPrice: number;
  marketPrice: number;
  sellPrice: number;
  p5Price: number;
  quantity: number;
  numAuctions: number;
  sellerCount: number;
  sellersInvisible: boolean;
  ownerVisible: boolean;
  observationVersion: number | null;
  sellerHHI: number | null;
  topSellerShare: number | null;
  marketType: string | null;
  bidOnlyCount: number;
  highestBid: number;
  soldProxyLow: number;
  soldProxyHigh: number;
  flowObserved: boolean;
  supplyGrowth: number;
  historySamples: number | null;
  historySpanHours: number | null;
  tierTruncated: boolean;
  topTiers: unknown;
  expiring: unknown;
};

type LegacyDaily = {
  marketId: string;
  itemId: number;
  date: Date;
  closePrice: number;
  lowPrice: number;
  volume: number;
};

function utcDay(t: number): number {
  const date = new Date(t * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

// Raw SQL hands the legacy columns back untyped. A value that is not a
// finite number means the database is corrupt, not that the fact is zero:
// defaulting it would put a fabricated price or timestamp into the rebuilt
// generation and call it history.
function numericReader(row: Record<string, unknown>): (column: string) => number {
  return (column) => {
    const value = row[column];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Legacy ${column} must be a finite number, got ${JSON.stringify(value)}`);
    }
    return value;
  };
}

function stringOf(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Legacy ${column} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

// The query engine hands DATETIME columns back as Date objects even though
// SQLite stores them as integer milliseconds. Accept exactly that shape: a
// coerced number here would silently date the whole history to 1970.
function dateOf(row: Record<string, unknown>, column: string): Date {
  const value = row[column];
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new Error(`Legacy ${column} must be a valid date, got ${JSON.stringify(value)}`);
}

function booleanOf(value: unknown): boolean {
  return Number(value) === 1 || value === true;
}

function jsonOf(value: unknown, column: string): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Legacy ${column} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    name
  );
  return rows.length > 0;
}

// Raw SQL does not validate against the Prisma schema, so the legacy tables
// load before the new models exist. Everything is read up front because
// `db push` destroys these tables.
async function loadLegacyRows(): Promise<{ snapshots: LegacySnapshot[]; dailies: LegacyDaily[] }> {
  const snapshots: LegacySnapshot[] = [];
  if (await tableExists("AuctionSnapshot")) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT market_id, item_id, timestamp, priced, min_price, market_price, sell_price, p5_price, quantity,
              num_auctions, seller_count, sellers_invisible, owner_visible, observation_version,
              seller_hhi, top_seller_share, market_type, bid_only_count, highest_bid, sold_proxy_low,
              sold_proxy_high, flow_observed, supply_growth, history_samples, history_span_hours,
              tier_truncated, top_tiers, expiring
       FROM "AuctionSnapshot" ORDER BY timestamp ASC`
    );
    snapshots.push(...rows.map((row) => {
      const n = numericReader(row);
      const nullable = (column: string) => (row[column] === null ? null : n(column));
      return {
        marketId: stringOf(row, "market_id"),
        itemId: n("item_id"),
        timestamp: dateOf(row, "timestamp"),
        priced: booleanOf(row.priced),
        minPrice: n("min_price"),
        marketPrice: n("market_price"),
        sellPrice: n("sell_price"),
        p5Price: n("p5_price"),
        quantity: n("quantity"),
        numAuctions: n("num_auctions"),
        sellerCount: n("seller_count"),
        sellersInvisible: booleanOf(row.sellers_invisible),
        ownerVisible: booleanOf(row.owner_visible),
        observationVersion: nullable("observation_version"),
        sellerHHI: nullable("seller_hhi"),
        topSellerShare: nullable("top_seller_share"),
        marketType: typeof row.market_type === "string" ? row.market_type : null,
        bidOnlyCount: n("bid_only_count"),
        highestBid: n("highest_bid"),
        soldProxyLow: n("sold_proxy_low"),
        soldProxyHigh: n("sold_proxy_high"),
        flowObserved: booleanOf(row.flow_observed),
        supplyGrowth: n("supply_growth"),
        historySamples: nullable("history_samples"),
        historySpanHours: nullable("history_span_hours"),
        tierTruncated: booleanOf(row.tier_truncated),
        topTiers: jsonOf(row.top_tiers, "top_tiers"),
        expiring: jsonOf(row.expiring, "expiring")
      };
    }));
  }

  const dailies: LegacyDaily[] = [];
  if (await tableExists("DailySummary")) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT market_id, item_id, date, close_price, low_price, volume
       FROM "DailySummary" ORDER BY date ASC`
    );
    dailies.push(...rows.map((row) => {
      const n = numericReader(row);
      return {
        marketId: stringOf(row, "market_id"),
        itemId: n("item_id"),
        date: dateOf(row, "date"),
        closePrice: n("close_price"),
        lowPrice: n("low_price"),
        volume: n("volume")
      };
    }));
  }
  return { snapshots, dailies };
}

function groupByMarket<T extends { marketId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.marketId) ?? [];
    list.push(row);
    out.set(row.marketId, list);
  }
  return out;
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
  const legacy = await loadLegacyRows();
  // Push the schema only after the legacy rows are in memory. `db push`
  // drops tables the schema no longer declares, so pushing first would
  // erase the history. --skip-generate because a running dev server holds
  // the query engine DLL on Windows.
  execSync("npx prisma db push --accept-data-loss --skip-generate", { stdio: "inherit" });
  const addonSeries = addonSeriesFor(process.env.AQT_SAVEDVARS_PATH);
  const markets = await prisma.market.findMany();
  const knownItemIds = new Set((await prisma.item.findMany({ select: { itemId: true } })).map((row) => row.itemId));
  const snapshotsByMarket = groupByMarket(legacy.snapshots);
  const dailiesByMarket = groupByMarket(legacy.dailies);
  let generations = 0;
  let seriesRows = 0;

  for (const market of markets) {
    const snapshots = snapshotsByMarket.get(market.id) ?? [];
    const dailies = dailiesByMarket.get(market.id) ?? [];
    const existingRows = await prisma.itemSeries.findMany({ where: { marketId: market.id } });
    if (snapshots.length === 0 && dailies.length === 0 && existingRows.length === 0) continue;

    const latestAt = snapshots.at(-1)?.timestamp ?? market.firstScanAt ?? new Date();
    // Private state is character-scoped now. Rebuild the observation from
    // the newest generation's character and that character's estate.
    const latestGeneration = await prisma.marketGeneration.findFirst({
      where: { marketId: market.id },
      orderBy: { scannedAt: "desc" },
      select: { character: true }
    });
    const character = latestGeneration?.character ?? "";
    const estate = character
      ? await prisma.estate.findUnique({
          where: { marketId_scope: { marketId: market.id, scope: `character:${character}` } },
          select: { cash: true, freeSlots: true }
        })
      : null;
    const latestSeconds = Math.round(latestAt.getTime() / 1000);
    const snapshotDays = new Set<string>();
    const legacyPoints = new Map<number, SeriesPoint[]>();
    for (const row of snapshots) {
      if (!row.priced || row.sellPrice <= 0) continue;
      const t = Math.round(row.timestamp.getTime() / 1000);
      snapshotDays.add(`${row.itemId}|${utcDay(t)}`);
      const points = legacyPoints.get(row.itemId) ?? [];
      points.push({
        t,
        minPrice: row.minPrice > 0 ? row.minPrice : row.sellPrice,
        sellPrice: row.sellPrice,
        quantity: row.quantity,
        numAuctions: row.numAuctions,
        event: false
      });
      legacyPoints.set(row.itemId, points);
    }
    for (const row of dailies) {
      if (row.closePrice <= 0) continue;
      const t = Math.round(row.date.getTime() / 1000);
      if (snapshotDays.has(`${row.itemId}|${utcDay(t)}`)) continue;
      const points = legacyPoints.get(row.itemId) ?? [];
      points.push({
        t,
        minPrice: row.lowPrice > 0 ? row.lowPrice : row.closePrice,
        sellPrice: row.closePrice,
        quantity: row.volume,
        numAuctions: 0,
        event: false
      });
      legacyPoints.set(row.itemId, points);
    }

    const incoming = addonSeries.get(`${market.realm}|${market.faction}`);
    // Persist the market's true first observation, matching the live import.
    // Phase age must not depend on how many generations pruning leaves
    // behind, so the anchor belongs on the Market row, not on the oldest
    // surviving generation.
    const seriesFirst = incoming?.firstScanAt ? new Date(incoming.firstScanAt * 1000) : null;
    const firstScanAt = [market.firstScanAt, seriesFirst, snapshots[0]?.timestamp]
      .filter((value): value is Date => value instanceof Date)
      .reduce<Date | null>((earliest, value) => (earliest === null || value < earliest ? value : earliest), null);
    if (firstScanAt && (!market.firstScanAt || firstScanAt < market.firstScanAt)) {
      await prisma.market.update({ where: { id: market.id }, data: { firstScanAt } });
    }
    const base = new Map<number, SeriesPoint[]>();
    for (const row of existingRows) base.set(row.itemId, arraysToSeries(row.points));
    for (const [itemId, points] of legacyPoints) {
      base.set(itemId, mergeSeries(base.get(itemId) ?? [], points, latestSeconds));
    }
    const merged = mergeSeriesByItem(
      Array.from(base.entries()).map(([itemId, points]) => ({ itemId, points })),
      incoming?.points ?? [],
      latestSeconds
    );
    seriesRows += merged.size;
    // The addon series names items that no imported scan ever carried (they
    // were listed earlier and dropped out). The series row has a foreign key
    // to Item, so create the same placeholder the live import would.
    const placeholderRows = Array.from(merged.keys())
      .filter((itemId) => !knownItemIds.has(itemId))
      .map((itemId) => scanPlaceholderItem(itemId));
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
        character: character || null,
        cash: estate?.cash ?? 0,
        openedAt: market.openedAt ? Math.round(market.openedAt.getTime() / 1000) : null,
        bagSlots: estate?.freeSlots ?? null,
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
        cash: estate?.cash ?? null,
        character,
        openedAt: market.openedAt,
        firstScanAt: market.firstScanAt,
        bagSlots: estate?.freeSlots ?? null,
        estateRevision: 0,
        dataVersion: market.dataVersion
      };
      const plan = buildGenerationPlan({
        scan,
        series: incoming ?? null,
        items: signalItems,
        existingSeries: Array.from(merged.entries()).map(([itemId, points]) => ({ itemId, points })),
        previous: null,
        openedAt: market.openedAt,
        firstScanAt: firstScanAt ?? snapshots[0].timestamp,
        positions: await getPositions(scope),
        ownSales: await getOwnSales(scope, latestAt),
        budgetCopper: resolveBudgetCopper(),
        phaseOverride: null
      });
      await prisma.$transaction(async (tx) => {
        if (placeholderRows.length > 0) await tx.item.createMany({ data: placeholderRows });
        await writeGeneration(
          tx,
          market.id,
          plan,
          plan.decisions.map((row) => ({ ...row, adoptedAt: null }))
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
        await replaceSeries(tx, market.id, seriesRowsFrom(merged));
      });
    }
  }

  // Legacy scan-owned rows conflated "not loaded" with "unsellable".
  const relabelled = await prisma.$executeRaw`
    UPDATE "Item" SET vendor_price = NULL
    WHERE catalog_source = ${SCAN_SOURCE} AND category = 'unknown' AND vendor_price = 0
  `;
  console.log(
    `Wrote ${generations} generations and ${seriesRows} item series; `
    + `relabelled ${Number(relabelled)} unknown vendor prices; the schema push dropped the legacy tables.`
  );
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
