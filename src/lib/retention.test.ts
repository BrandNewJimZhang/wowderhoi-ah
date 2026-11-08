// Retention is SQL against the real SQLite dialect, so the test runs it
// against a throwaway database rather than a mock: a cascade is exactly the
// thing a mock would pretend to verify.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-retention-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8);

let prisma: typeof import("@/lib/prisma").prisma;
let pruneGenerations: typeof import("@/lib/retention").pruneGenerations;
let pruneAgedRows: typeof import("@/lib/retention").pruneAgedRows;

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ pruneGenerations, pruneAgedRows } = await import("@/lib/retention"));
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "MarketGeneration" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "scanned_at" DATETIME)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "MarketQuote" ("generation_id" TEXT, "item_id" INTEGER,
      PRIMARY KEY ("generation_id", "item_id"),
      FOREIGN KEY ("generation_id") REFERENCES "MarketGeneration"("id") ON DELETE CASCADE)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "Decision" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "at" DATETIME, "generation_id" TEXT)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "ImportRun" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "received_at" DATETIME)`
  );
  for (let day = 1; day <= 5; day += 1) {
    const id = `g${day}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketGeneration" VALUES ('${id}', 'm1', ${NOW - (5 - day) * DAY})`
    );
    await prisma.$executeRawUnsafe(`INSERT INTO "MarketQuote" VALUES ('${id}', 1)`);
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "MarketGeneration" VALUES ('other', 'm2', ${NOW - DAY})`);
  await prisma.$executeRawUnsafe(`INSERT INTO "MarketQuote" VALUES ('other', 1)`);
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("pruneGenerations", () => {
  it("keeps the newest generations for one market and cascades their quotes", async () => {
    expect(await pruneGenerations("m1", 2)).toBe(3);
    const remaining = await prisma.$queryRawUnsafe<Array<{ id: string; count: bigint }>>(
      `SELECT g.id AS id, COUNT(q.item_id) AS count
       FROM "MarketGeneration" g LEFT JOIN "MarketQuote" q ON q.generation_id = g.id
       WHERE g.market_id = 'm1' GROUP BY g.id ORDER BY g.scanned_at`
    );
    expect(remaining.map((row) => row.id)).toEqual(["g4", "g5"]);
    expect(remaining.every((row) => Number(row.count) === 1)).toBe(true);
    // Another market's generation is not a pruning candidate.
    const other = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "MarketGeneration" WHERE market_id = 'm2'`
    );
    expect(Number(other[0].count)).toBe(1);
  });

  it("is idempotent and rejects a nonsensical keep", async () => {
    expect(await pruneGenerations("m1", 2)).toBe(0);
    await expect(pruneGenerations("m1", 0)).rejects.toThrow(/positive integer/);
  });
});

describe("pruneAgedRows", () => {
  it("drops aged decisions and import runs but keeps fresh rows", async () => {
    const now = new Date(NOW);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Decision" VALUES ('old', 'm1', ${NOW - 91 * DAY}, NULL), ('new', 'm1', ${NOW - 10 * DAY}, NULL)`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ImportRun" VALUES ('old', 'm1', ${NOW - 31 * DAY}), ('new', 'm1', ${NOW - 2 * DAY})`
    );
    expect(await pruneAgedRows(now)).toEqual({ decisions: 1, importRuns: 1 });
    const decisions = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Decision"`);
    const runs = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "ImportRun"`);
    expect(decisions.map((row) => row.id)).toEqual(["new"]);
    expect(runs.map((row) => row.id)).toEqual(["new"]);
  });
});
