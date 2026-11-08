// A replay can re-create a generation that pruning removed while the
// decisions it wrote are still inside the 90-day log. The decision identity
// is unique, so the write path has to replace the surviving row instead of
// colliding with it; these run against the real dialect on a throwaway
// database because the constraint is what fails, not the TypeScript types.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GenerationPlan } from "@/lib/market-generation";

const directory = mkdtempSync(path.join(tmpdir(), "wah-import-store-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

const SCANNED_AT = new Date("2026-11-08T10:00:00Z");
const ADOPTED_AT = new Date("2026-11-08T10:05:00Z");

let prisma: typeof import("@/lib/prisma").prisma;
let writeGeneration: typeof import("@/lib/import-store").writeGeneration;

function plan(decisionId: string): GenerationPlan {
  return {
    scannedAt: SCANNED_AT,
    phase: "settle",
    breadth: 1,
    staleCount: 0,
    firstScanAt: SCANNED_AT,
    priceIndex: { dates: [], values: [], baseDate: "" },
    core: {
      phase: "settle",
      rows: [],
      opportunities: [],
      actions: [],
      diagnostics: { excluded: {}, unfunded: { kelly: 0, exposure: 0, purse: 0, depth: 0 } }
    },
    gapMinutes: null,
    quotes: [],
    signals: [],
    series: [],
    decisions: [{
      decisionId,
      itemId: 1,
      kind: "buy",
      reason: "test",
      expectedNet: 100,
      fillProb: 0.5,
      fillBasis: "prior",
      allocQty: 1,
      allocUnitPrice: 100
    }],
    seriesPointCount: 0
  };
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ writeGeneration } = await import("@/lib/import-store"));
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketGeneration" (
    "id" TEXT PRIMARY KEY, "market_id" TEXT, "scanned_at" DATETIME, "phase" TEXT,
    "breadth" INTEGER, "stale_count" INTEGER, "first_scan_at" DATETIME,
    "price_index" TEXT, "core" TEXT, "gap_minutes" INTEGER, "created_at" DATETIME)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketQuote" (
    "generation_id" TEXT, "market_id" TEXT, "item_id" INTEGER, "priced" BOOLEAN,
    "min_price" REAL, "market_price" REAL, "sell_price" REAL, "p5_price" REAL,
    "quantity" INTEGER, "num_auctions" INTEGER, "seller_count" INTEGER,
    "sellers_invisible" BOOLEAN, "owner_visible" BOOLEAN, "observation_version" INTEGER,
    "seller_hhi" REAL, "top_seller_share" REAL, "market_type" TEXT,
    "bid_only_count" INTEGER, "highest_bid" REAL, "sold_proxy_low" REAL,
    "sold_proxy_high" REAL, "flow_observed" BOOLEAN, "supply_growth" REAL,
    "history_samples" INTEGER, "history_span_hours" REAL, "tier_truncated" BOOLEAN,
    "top_tiers" TEXT, "expiring" TEXT, PRIMARY KEY ("generation_id", "item_id"))`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "MarketSignalRow" (
    "generation_id" TEXT, "item_id" INTEGER, "data" TEXT, PRIMARY KEY ("generation_id", "item_id"))`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "ItemSeries" (
    "market_id" TEXT, "item_id" INTEGER, "first_at" DATETIME, "last_at" DATETIME,
    "point_count" INTEGER, "points" TEXT, "updated_at" DATETIME,
    PRIMARY KEY ("market_id", "item_id"))`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "Decision" (
    "id" TEXT PRIMARY KEY, "decision_id" TEXT UNIQUE, "generation_id" TEXT,
    "adopted_at" DATETIME, "market_id" TEXT, "at" DATETIME, "phase" TEXT,
    "item_id" INTEGER, "kind" TEXT, "reason" TEXT, "expected_net" REAL,
    "fill_prob" REAL, "fill_basis" TEXT, "alloc_qty" INTEGER, "alloc_unit_price" REAL)`);
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("writeGeneration", () => {
  it("writes a generation and its decisions", async () => {
    await prisma.$transaction((tx) =>
      writeGeneration(tx, "m1", plan("R|A|1:1:buy"), plan("R|A|1:1:buy").decisions.map((row) => ({ ...row, adoptedAt: null })))
    );
    const decisions = await prisma.decision.findMany({ where: { marketId: "m1" } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionId).toBe("R|A|1:1:buy");
    expect(await prisma.marketGeneration.count({ where: { marketId: "m1" } })).toBe(1);
  });

  it("re-creates a pruned generation without colliding on the decision identity", async () => {
    // The generation was pruned; its decision row outlived it (the log keeps
    // 90 days), and the player had adopted that recommendation.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Decision" ("id", "decision_id", "generation_id", "adopted_at", "market_id", "at", "phase", "item_id", "kind")
       VALUES ('old-decision', 'R|A|2:1:buy', NULL, ?, 'm1', ?, 'settle', 1, 'buy')`,
      ADOPTED_AT.getTime(),
      new Date("2026-11-06T10:00:00Z").getTime()
    );
    const replay = plan("R|A|2:1:buy");
    await expect(prisma.$transaction((tx) =>
      writeGeneration(tx, "m1", replay, replay.decisions.map((row) => ({ ...row, adoptedAt: null })))
    )).resolves.toEqual(expect.any(String));

    const decisions = await prisma.decision.findMany({ where: { decisionId: "R|A|2:1:buy" } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].adoptedAt?.getTime()).toBe(ADOPTED_AT.getTime());
    expect(decisions[0].generationId).not.toBeNull();
  });
});
