// Seeds a throwaway perf database (prisma/perf.db by default) with a
// deterministic synthetic market. Never touches dev.db.
//   npm run perf:seed -- --items 2600 --depth 8 [--db prisma/perf.db] [--seed 1]
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_BUDGET_COPPER, SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";
import { generateMarket, syntheticMarketType, syntheticSellers, syntheticTiers } from "./fixtures";
import { qualityName } from "@/lib/quality";
import { buildGenerationPlan } from "@/lib/market-generation";
import { writeGeneration } from "@/lib/import-store";
import type { AddonScan, AddonScanItem } from "@/lib/addon-scan";
import type { SeriesPoint } from "@/lib/item-series";

// The synthetic history must walk at the compiled scan cadence, or the
// elapsed-time and per-day folding the perf pages measure would describe a
// different ticker than /wahauto runs.
const SCAN_INTERVAL_MS = SCAN_INTERVAL_MINUTES * 60 * 1000;
const INSERT_CHUNK = 2000;

const { values } = parseArgs({
  options: {
    items: { type: "string", default: "2600" },
    depth: { type: "string", default: "8" },
    db: { type: "string", default: "prisma/perf.db" },
    seed: { type: "string", default: "1" }
  }
});
const itemCount = Number(values.items);
const depth = Number(values.depth);
if (!Number.isInteger(itemCount) || itemCount <= 0 || !Number.isInteger(depth) || depth <= 0) {
  throw new Error(`--items and --depth must be positive integers, got ${values.items}/${values.depth}`);
}
// Prisma resolves relative sqlite URLs against prisma/schema.prisma, so
// anchor on an absolute path to keep CLI args cwd-relative.
const dbPath = `${process.cwd()}/${values.db!}`;
const databaseUrl = `file:${dbPath}`;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    await insert(rows.slice(offset, offset + INSERT_CHUNK));
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(`Seeding ${itemCount} items x ${depth} snapshots into ${dbPath}`);
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    shell: true
  });

  const market = generateMarket({ itemCount, depth, seed: Number(values.seed) });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const newestScanMs = Date.now();
  // The core bounds every purchase by the scanned purse. A zero-cash market
  // makes candidateQty zero for every row, so the cockpit renders an empty
  // radar and the perf run measures a dead page; fund the fixture at the
  // planning budget so the decision path actually runs.
  const marketRow = await prisma.market.create({
    data: { realm: "PerfRealm", faction: "Alliance", cash: DEFAULT_BUDGET_COPPER }
  });

  await insertChunked(
    market.items.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      quality: qualityName(item.qualityIndex),
      category: item.itemClass,
      subCategory: item.itemSubClass
    })),
    (chunk) => prisma.item.createMany({ data: chunk })
  );

  // The walk is the series; the last step of each item is the current
  // book. One generation is enough for the perf pages: they read the newest
  // generation, exactly like production.
  const series = market.items.map((item) => ({
    itemId: item.itemId,
    points: item.walk.map((point, step): SeriesPoint => ({
      t: Math.round((newestScanMs - (item.walk.length - 1 - step) * SCAN_INTERVAL_MS) / 1000),
      minPrice: point.minPrice,
      sellPrice: point.marketPrice,
      quantity: point.quantity,
      numAuctions: point.numAuctions,
      event: false
    }))
  }));
  const scanItems: AddonScanItem[] = market.items.map((item) => {
    const point = item.walk[item.walk.length - 1];
    return {
      itemId: item.itemId,
      name: item.name,
      quality: qualityName(item.qualityIndex),
      category: item.itemClass,
      subCategory: item.itemSubClass,
      marketType: syntheticMarketType(item, point),
      priced: true,
      minPrice: point.minPrice,
      marketPrice: point.marketPrice,
      sellPrice: point.marketPrice,
      p5Price: point.minPrice,
      quantity: point.quantity,
      numAuctions: point.numAuctions,
      sellerCount: syntheticSellers(point),
      sellersInvisible: false,
      ownerVisible: true,
      sellerHHI: null,
      topSellerShare: null,
      bidOnlyCount: 0,
      highestBid: 0,
      inferredSoldLow: 0,
      inferredSoldHigh: 0,
      flowObserved: true,
      supplyGrowth: 0,
      historySamples: item.walk.length,
      historySpanHours: (item.walk.length * SCAN_INTERVAL_MINUTES) / 60,
      vendorPrice: 0,
      tiers: syntheticTiers(point),
      tierTruncated: false,
      expiring: { soon: 0, mid: 0, late: 0 }
    };
  });
  const scan: AddonScan = {
    scannedAt: new Date(newestScanMs),
    server: "PerfRealm",
    faction: "Alliance",
    character: "Perf",
    cash: DEFAULT_BUDGET_COPPER,
    openedAt: null,
    bagSlots: 20,
    observationVersion: 2,
    skippedItems: 0,
    items: scanItems
  };
  const signalItems = new Map(market.items.map((item) => [item.itemId, {
    itemId: item.itemId,
    name: item.name,
    quality: qualityName(item.qualityIndex),
    category: item.itemClass,
    subCategory: item.itemSubClass,
    vendorPrice: 0,
    iconId: null
  }] as const));
  const plan = buildGenerationPlan({
    scan,
    series: null,
    items: signalItems,
    existingSeries: series,
    previous: null,
    openedAt: null,
    firstScanAt: new Date(newestScanMs - (depth * SCAN_INTERVAL_MS)),
    positions: {},
    ownSales: {},
    budgetCopper: DEFAULT_BUDGET_COPPER,
    phaseOverride: null
  });
  await prisma.$transaction(async (tx) => {
    await writeGeneration(tx, marketRow.id, plan, plan.decisions.map((row) => ({ ...row, adoptedAt: null })));
  }, { timeout: 120_000 });

  const counts = {
    items: await prisma.item.count(),
    series: await prisma.itemSeries.count(),
    signals: await prisma.marketSignalRow.count()
  };
  await prisma.$disconnect();
  console.log(`Seeded ${counts.items} items, ${counts.series} series, ${counts.signals} signals in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

void main();
