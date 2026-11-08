// Retention is SQL against the real SQLite dialect, so the test runs it
// against a throwaway database rather than a mock: a window-function
// partition is exactly the thing a mock would pretend to verify.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-retention-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let prisma: typeof import("@/lib/prisma").prisma;
let pruneSnapshots: typeof import("@/lib/retention").pruneSnapshots;

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ pruneSnapshots } = await import("@/lib/retention"));
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "AuctionSnapshot" ("id" TEXT PRIMARY KEY, "market_id" TEXT, "item_id" INTEGER, "timestamp" DATETIME)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "Market" ("id" TEXT PRIMARY KEY, "first_scan_at" DATETIME)`
  );
  await prisma.$executeRawUnsafe(`INSERT INTO "Market" VALUES ('m1', NULL)`);
  const rows: string[] = [];
  for (let timestamp = 1; timestamp <= 100; timestamp += 1) {
    rows.push(`('a${timestamp}', 'm1', 1, ${timestamp})`);
  }
  // This item's points start later, so after the prune the oldest surviving
  // snapshot is 5; a first_scan_at of 1 proves the anchor was captured
  // before the deletion.
  for (let timestamp = 1; timestamp <= 10; timestamp += 1) {
    rows.push(`('b${timestamp}', 'm1', 2, ${timestamp + 100})`);
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "AuctionSnapshot" VALUES ${rows.join(", ")}`);
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("pruneSnapshots", () => {
  it("keeps the newest rows per item and deletes only the superseded ones", async () => {
    expect(await pruneSnapshots(96)).toBe(4);
    const itemOne = await prisma.$queryRawUnsafe<Array<{ count: bigint; oldest: number }>>(
      `SELECT COUNT(*) AS count, MIN(timestamp) AS oldest FROM "AuctionSnapshot" WHERE item_id = 1`
    );
    expect(Number(itemOne[0].count)).toBe(96);
    expect(Number(itemOne[0].oldest)).toBe(5);
    // A short series is untouched: the prune is per item, not per market.
    const itemTwo = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "AuctionSnapshot" WHERE item_id = 2`
    );
    expect(Number(itemTwo[0].count)).toBe(10);
    // The phase anchor was persisted from the pre-prune oldest snapshot, so
    // retention cannot make the market look younger than it is.
    const market = await prisma.$queryRawUnsafe<Array<{ first_scan_at: number | null }>>(
      `SELECT first_scan_at FROM "Market" WHERE id = 'm1'`
    );
    expect(Number(market[0].first_scan_at)).toBe(1);
  });

  it("is idempotent", async () => {
    expect(await pruneSnapshots(96)).toBe(0);
  });

  it("rejects a nonsensical keep value instead of deleting everything", async () => {
    await expect(pruneSnapshots(0)).rejects.toThrow(/positive integer/);
  });
});
