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

async function generationIds(marketId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "MarketGeneration" WHERE "market_id" = ? ORDER BY "scanned_at"`,
    marketId
  );
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ pruneGenerations, pruneAgedRows } = await import("@/lib/retention"));
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "MarketGeneration" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "scanned_at" DATETIME,
      "phase" TEXT DEFAULT 'settle', "core" TEXT)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "MarketQuote" ("generation_id" TEXT, "item_id" INTEGER,
      PRIMARY KEY ("generation_id", "item_id"),
      FOREIGN KEY ("generation_id") REFERENCES "MarketGeneration"("id") ON DELETE CASCADE)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "MarketSignalRow" ("generation_id" TEXT, "item_id" INTEGER, "data" TEXT,
      PRIMARY KEY ("generation_id", "item_id"),
      FOREIGN KEY ("generation_id") REFERENCES "MarketGeneration"("id") ON DELETE CASCADE)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "Decision" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "at" DATETIME,
      "generation_id" TEXT, "decision_id" TEXT)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "Trade" ("id" TEXT PRIMARY KEY, "decision_id" TEXT)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "ImportRun" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "received_at" DATETIME)`
  );
  for (let day = 1; day <= 5; day += 1) {
    const id = `g${day}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketGeneration" ("id", "market_id", "scanned_at", "core") VALUES (?, 'm1', ?, ?)`,
      id,
      NOW - (5 - day) * DAY,
      JSON.stringify({ phase: "settle", rows: [{ itemId: 1 }], opportunities: [], actions: [] })
    );
    await prisma.$executeRawUnsafe(`INSERT INTO "MarketQuote" VALUES (?, 1)`, id);
    await prisma.$executeRawUnsafe(`INSERT INTO "MarketSignalRow" VALUES (?, 1, '{}')`, id);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MarketGeneration" ("id", "market_id", "scanned_at", "core") VALUES ('other', 'm2', ?, '{}')`,
    NOW - DAY
  );
  await prisma.$executeRawUnsafe(`INSERT INTO "MarketQuote" VALUES ('other', 1)`);
  await prisma.$executeRawUnsafe(`INSERT INTO "MarketSignalRow" VALUES ('other', 1, '{}')`);
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("pruneGenerations", () => {
  it("keeps quotes for calibration while only the newest generations stay readable", async () => {
    expect(await pruneGenerations("m1", 2, 5)).toBe(0);
    expect(await generationIds("m1")).toEqual(["g1", "g2", "g3", "g4", "g5"]);

    const signals = await prisma.$queryRawUnsafe<Array<{ generation_id: string }>>(
      `SELECT "generation_id" FROM "MarketSignalRow" WHERE "generation_id" LIKE 'g%' ORDER BY "generation_id"`
    );
    expect(signals.map((row) => row.generation_id)).toEqual(["g4", "g5"]);

    const quotes = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "MarketQuote" WHERE "generation_id" LIKE 'g%'`
    );
    expect(Number(quotes[0].count)).toBe(5);

    const stripped = await prisma.$queryRawUnsafe<Array<{ core: string }>>(
      `SELECT "core" FROM "MarketGeneration" WHERE "id" = 'g1'`
    );
    const core = JSON.parse(stripped[0].core) as { phase: string; rows: unknown[] };
    expect(core.phase).toBe("settle");
    expect(core.rows).toEqual([]);

    // Another market's generations are not pruning candidates.
    expect(await generationIds("m2")).toEqual(["other"]);
  });

  it("drops generations past the calibration window with their quotes", async () => {
    expect(await pruneGenerations("m1", 2, 3)).toBe(2);
    expect(await generationIds("m1")).toEqual(["g3", "g4", "g5"]);
    const quotes = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "MarketQuote" WHERE "generation_id" IN ('g1', 'g2')`
    );
    expect(Number(quotes[0].count)).toBe(0);
  });

  it("is idempotent and rejects a nonsensical policy", async () => {
    expect(await pruneGenerations("m1", 2, 3)).toBe(0);
    await expect(pruneGenerations("m1", 0, 3)).rejects.toThrow(/positive integer/);
    await expect(pruneGenerations("m1", 2, 1)).rejects.toThrow(/calibrationKeep/);
  });
});

describe("pruneAgedRows", () => {
  it("drops aged decisions and import runs but keeps fresh rows", async () => {
    const now = new Date(NOW);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Decision" ("id", "market_id", "at", "generation_id") VALUES
        ('old', 'm1', ${NOW - 91 * DAY}, NULL), ('new', 'm1', ${NOW - 10 * DAY}, NULL)`
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

  it("keeps an aged decision that a permanent trade still cites", async () => {
    // Trades outlive the decision log. Deleting the decision they point at
    // would make a replay erase the trade's attribution with no way back.
    const now = new Date(NOW);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Decision" ("id", "market_id", "at", "generation_id", "decision_id") VALUES
        ('linked', 'm1', ${NOW - 120 * DAY}, NULL, 'd-linked'),
        ('orphan', 'm1', ${NOW - 120 * DAY}, NULL, 'd-orphan')`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Trade" ("id", "decision_id") VALUES ('t1', 'd-linked')`
    );
    expect(await pruneAgedRows(now)).toEqual({ decisions: 1, importRuns: 0 });
    const decisions = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Decision" ORDER BY id`);
    expect(decisions.map((row) => row.id)).toEqual(["linked", "new"]);
  });
});
