// The item read path joins a quote to its own generation's signal row.
// That is SQL against the real dialect, so the test runs it on a throwaway
// database: a mock would happily return the row the query must exclude.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-repositories-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

const OLD = Date.UTC(2026, 10, 7, 10);
const NEW = Date.UTC(2026, 10, 8, 10);

let prisma: typeof import("@/lib/prisma").prisma;
let getItemDetail: typeof import("@/lib/repositories").getItemDetail;

const scope = { id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0, character: "Tester" };

function signalData(sellPrice: number) {
  return JSON.stringify({
    schemaVersion: 1,
    signal: { itemId: 1, sellPrice, minPrice: sellPrice, quantity: 10, numAuctions: 1, stale: false },
    coreRow: null,
    previousAt: null
  });
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ getItemDetail } = await import("@/lib/repositories"));
  await prisma.$executeRawUnsafe(`CREATE TABLE "Item" (
    "id" TEXT PRIMARY KEY, "item_id" INTEGER UNIQUE, "name" TEXT, "quality" TEXT,
    "category" TEXT, "sub_category" TEXT, "vendor_price" REAL, "icon_id" INTEGER,
    "item_level" INTEGER, "required_level" INTEGER, "slot" TEXT, "type_label" TEXT,
    "catalog_source" TEXT DEFAULT 'scan', "catalog_build" TEXT, "catalog_updated_at" DATETIME,
    "created_at" DATETIME DEFAULT 0, "updated_at" DATETIME DEFAULT 0)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketGeneration" (
    "id" TEXT PRIMARY KEY, "market_id" TEXT, "scanned_at" DATETIME, "phase" TEXT,
    "breadth" INTEGER, "stale_count" INTEGER, "first_scan_at" DATETIME,
    "price_index" TEXT, "core" TEXT, "gap_minutes" INTEGER,
    "created_at" DATETIME)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketQuote" (
    "generation_id" TEXT, "market_id" TEXT, "item_id" INTEGER, "priced" BOOLEAN DEFAULT 1,
    "min_price" REAL DEFAULT 0, "market_price" REAL DEFAULT 0, "sell_price" REAL DEFAULT 0,
    "p5_price" REAL DEFAULT 0, "quantity" INTEGER DEFAULT 0, "num_auctions" INTEGER DEFAULT 0,
    "seller_count" INTEGER DEFAULT 0, "sellers_invisible" BOOLEAN DEFAULT 0,
    "owner_visible" BOOLEAN DEFAULT 0, "observation_version" INTEGER,
    "seller_hhi" REAL, "top_seller_share" REAL, "market_type" TEXT,
    "bid_only_count" INTEGER DEFAULT 0, "highest_bid" REAL DEFAULT 0,
    "sold_proxy_low" REAL DEFAULT 0, "sold_proxy_high" REAL DEFAULT 0,
    "flow_observed" BOOLEAN DEFAULT 1, "supply_growth" REAL DEFAULT 0,
    "history_samples" INTEGER, "history_span_hours" REAL, "tier_truncated" BOOLEAN DEFAULT 0,
    "top_tiers" TEXT, "expiring" TEXT, PRIMARY KEY ("generation_id", "item_id"))`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketSignalRow" (
    "generation_id" TEXT, "item_id" INTEGER, "data" TEXT, PRIMARY KEY ("generation_id", "item_id"))`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "ItemSeries" (
    "market_id" TEXT, "item_id" INTEGER, "first_at" DATETIME, "last_at" DATETIME,
    "point_count" INTEGER, "points" TEXT, "updated_at" DATETIME,
    PRIMARY KEY ("market_id", "item_id"))`);

  for (const [id, at] of [["g-old", OLD], ["g-new", NEW]] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketGeneration" ("id", "market_id", "scanned_at", "phase", "breadth")
       VALUES (?, 'm1', ?, 'settle', 100)`,
      id,
      at
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Item" ("id", "item_id", "name", "quality", "category", "sub_category", "catalog_source")
     VALUES ('i1', 1, 'Test Item', 'common', '商品', '布', 'wuxianwow.com')`
  );
  // The older generation was priced and stored a signal; the newest saw the
  // item bid-only, so it has a quote but no signal row.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MarketQuote" ("generation_id", "market_id", "item_id", "priced", "min_price", "market_price", "sell_price", "quantity", "num_auctions")
     VALUES ('g-old', 'm1', 1, 1, 400, 450, 500, 10, 2)`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MarketQuote" ("generation_id", "market_id", "item_id", "priced", "min_price", "market_price", "sell_price", "quantity", "num_auctions", "bid_only_count")
     VALUES ('g-new', 'm1', 1, 0, 0, 0, 0, 0, 0, 3)`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MarketSignalRow" ("generation_id", "item_id", "data") VALUES ('g-old', 1, ?)`,
    signalData(500)
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("getItemDetail", () => {
  it("never pairs the newest book with an older generation's signal", async () => {
    const detail = await getItemDetail(1, scope);
    expect(detail?.quote?.timestamp.getTime()).toBe(NEW);
    expect(detail?.quote?.priced).toBe(false);
    expect(detail?.quote?.bidOnlyCount).toBe(3);
    expect(detail?.signal).toBeNull();
  });

  it("returns the signal stored with the quote's own generation", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Item" ("id", "item_id", "name", "quality", "category", "sub_category", "catalog_source")
       VALUES ('i2', 2, 'Second Item', 'common', '商品', '布', 'wuxianwow.com')`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketQuote" ("generation_id", "market_id", "item_id", "priced", "min_price", "market_price", "sell_price", "quantity", "num_auctions")
       VALUES ('g-new', 'm1', 2, 1, 100, 110, 120, 5, 1)`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketSignalRow" ("generation_id", "item_id", "data") VALUES ('g-new', 2, ?)`,
      signalData(120)
    );
    const detail = await getItemDetail(2, scope);
    expect(detail?.quote?.timestamp.getTime()).toBe(NEW);
    expect(detail?.signal?.signal.sellPrice).toBe(120);
  });
});
