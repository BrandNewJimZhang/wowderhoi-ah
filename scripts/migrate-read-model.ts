// One-off migration from the snapshot read model to generations + a
// terminal-owned series. Reconstructs the series from the retained
// snapshots and daily summaries, merges the addon's own series when the
// SavedVariables file is available, and materialises one generation from
// each market's newest snapshot.
//
// The legacy tables are read through raw SQL: they no longer exist in the
// Prisma schema, but an old database still needs this path once. A database
// that never had them is simply the no-op case.
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { parseSavedVariables, type AddonScan, type AddonScanItem } from "@/lib/addon-scan";
import { arraysToSeries, parseAddonSeries, mergeSeries, mergeSeriesByItem, type AddonSeries, type SeriesPoint } from "@/lib/item-series";
import { buildGenerationPlan, seriesRowsFrom } from "@/lib/market-generation";
import { scanPlaceholderItem } from "@/lib/scan-import";
import { SCAN_SOURCE } from "@/lib/item-catalog";
import { writeGeneration, replaceSeries } from "@/lib/import-store";
import { getLedgerRevision, getOwnSales, getPositions } from "@/lib/repositories";
import { resolveBudgetCopper } from "@/lib/config";
import type { MarketScope } from "@/lib/market-scope";

process.loadEnvFile();

type LegacySnapshot = {
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

function numberOr(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function booleanOf(value: unknown): boolean {
  return Number(value) === 1 || value === true;
}

function jsonOf(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    name
  );
  return rows.length > 0;
}

async function loadSnapshots(marketId: string): Promise<LegacySnapshot[]> {
  if (!(await tableExists("AuctionSnapshot"))) return [];
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT item_id, timestamp, priced, min_price, market_price, sell_price, p5_price, quantity,
            num_auctions, seller_count, sellers_invisible, owner_visible, observation_version,
            seller_hhi, top_seller_share, market_type, bid_only_count, highest_bid, sold_proxy_low,
            sold_proxy_high, flow_observed, supply_growth, history_samples, history_span_hours,
            tier_truncated, top_tiers, expiring
     FROM "AuctionSnapshot" WHERE market_id = ? ORDER BY timestamp ASC`,
    marketId
  );
  return rows.map((row) => ({
    itemId: Number(row.item_id),
    timestamp: new Date(numberOr(row.timestamp)),
    priced: booleanOf(row.priced),
    minPrice: numberOr(row.min_price),
    marketPrice: numberOr(row.market_price),
    sellPrice: numberOr(row.sell_price),
    p5Price: numberOr(row.p5_price),
    quantity: numberOr(row.quantity),
    numAuctions: numberOr(row.num_auctions),
    sellerCount: numberOr(row.seller_count),
    sellersInvisible: booleanOf(row.sellers_invisible),
    ownerVisible: booleanOf(row.owner_visible),
    observationVersion: row.observation_version === null ? null : numberOr(row.observation_version),
    sellerHHI: row.seller_hhi === null ? null : numberOr(row.seller_hhi),
    topSellerShare: row.top_seller_share === null ? null : numberOr(row.top_seller_share),
    marketType: typeof row.market_type === "string" ? row.market_type : null,
    bidOnlyCount: numberOr(row.bid_only_count),
    highestBid: numberOr(row.highest_bid),
    soldProxyLow: numberOr(row.sold_proxy_low),
    soldProxyHigh: numberOr(row.sold_proxy_high),
    flowObserved: booleanOf(row.flow_observed),
    supplyGrowth: numberOr(row.supply_growth),
    historySamples: row.history_samples === null ? null : numberOr(row.history_samples),
    historySpanHours: row.history_span_hours === null ? null : numberOr(row.history_span_hours),
    tierTruncated: booleanOf(row.tier_truncated),
    topTiers: jsonOf(row.top_tiers),
    expiring: jsonOf(row.expiring)
  }));
}

async function loadDailies(marketId: string): Promise<LegacyDaily[]> {
  if (!(await tableExists("DailySummary"))) return [];
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT item_id, date, close_price, low_price, volume
     FROM "DailySummary" WHERE market_id = ? ORDER BY date ASC`,
    marketId
  );
  return rows.map((row) => ({
    itemId: Number(row.item_id),
    date: new Date(numberOr(row.date)),
    closePrice: numberOr(row.close_price),
    lowPrice: numberOr(row.low_price),
    volume: numberOr(row.volume)
  }));
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
    const snapshots = await loadSnapshots(market.id);
    const dailies = await loadDailies(market.id);
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
    const base = new Map<number, SeriesPoint[]>();
    for (const row of existingRows) base.set(row.itemId, arraysToSeries(row.points));
    for (const [itemId, points] of legacy) {
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
        await replaceSeries(tx, market.id, seriesRowsFrom(merged));
      });
    }
  }

  // Legacy scan-owned rows conflated "not loaded" with "unsellable".
  const relabelled = await prisma.$executeRaw`
    UPDATE "Item" SET vendor_price = NULL
    WHERE catalog_source = ${SCAN_SOURCE} AND category = 'unknown' AND vendor_price = 0
  `;
  const dropped = await dropLegacyTables();
  console.log(
    `Wrote ${generations} generations and ${seriesRows} item series; `
    + `relabelled ${Number(relabelled)} unknown vendor prices; dropped ${dropped} legacy tables.`
  );
}

async function dropLegacyTables(): Promise<number> {
  let dropped = 0;
  for (const table of ["AuctionSnapshot", "DailySummary"]) {
    if (await tableExists(table)) {
      await prisma.$executeRawUnsafe(`DROP TABLE "${table}"`);
      dropped += 1;
    }
  }
  return dropped;
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
