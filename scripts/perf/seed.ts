// Seeds a throwaway perf database (prisma/perf.db by default) with a
// deterministic synthetic market. Never touches dev.db.
//   npm run perf:seed -- --items 2600 --depth 8 [--db prisma/perf.db] [--seed 1]
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { generateMarket, qualityName, type SyntheticMarket } from "./fixtures";

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // matches /wahauto cadence
const SCANS_PER_DAY = (24 * 60) / 15;
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

function dailySummariesFor(market: SyntheticMarket, newestScanMs: number) {
  const rows: Array<{ itemId: number; date: Date; openPrice: number; closePrice: number; highPrice: number; lowPrice: number; volume: number }> = [];
  for (const item of market.items) {
    for (let start = 0; start < item.walk.length; start += SCANS_PER_DAY) {
      const day = item.walk.slice(start, start + SCANS_PER_DAY);
      const prices = day.map((point) => point.marketPrice);
      const timestampMs = newestScanMs - (item.walk.length - 1 - start) * SCAN_INTERVAL_MS;
      const date = new Date(timestampMs);
      date.setUTCHours(0, 0, 0, 0);
      rows.push({
        itemId: item.itemId,
        date,
        openPrice: prices[0],
        closePrice: prices[prices.length - 1],
        highPrice: Math.max(...prices),
        lowPrice: Math.min(...prices),
        volume: day.reduce((sum, point) => sum + point.quantity, 0)
      });
    }
  }
  return rows;
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

  const snapshotRows = market.items.flatMap((item) =>
    item.walk.map((point, step) => ({
      itemId: item.itemId,
      timestamp: new Date(newestScanMs - (item.walk.length - 1 - step) * SCAN_INTERVAL_MS),
      server: "PerfRealm",
      faction: "Alliance",
      minPrice: point.minPrice,
      marketPrice: point.marketPrice,
      quantity: point.quantity,
      numAuctions: point.numAuctions
    }))
  );
  await insertChunked(snapshotRows, (chunk) => prisma.auctionSnapshot.createMany({ data: chunk }));
  await insertChunked(dailySummariesFor(market, newestScanMs), (chunk) => prisma.dailySummary.createMany({ data: chunk }));

  const counts = {
    items: await prisma.item.count(),
    snapshots: await prisma.auctionSnapshot.count(),
    summaries: await prisma.dailySummary.count()
  };
  await prisma.$disconnect();
  console.log(`Seeded ${counts.items} items, ${counts.snapshots} snapshots, ${counts.summaries} summaries in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

void main();
