// The auto-refresh revision is the newest import run of a market: the run is
// recorded after each import transaction commits, so a new run means the
// pages may be stale. These run against the real dialect because the index
// and ordering are the point; a mock could return the wrong row happily.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-market-revision-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let prisma: typeof import("@/lib/prisma").prisma;
let getMarketRevision: typeof import("@/lib/repositories").getMarketRevision;

const scope = { id: "m1", realm: "TestRealm", faction: "Alliance", cash: 0, character: "Tester" };

async function insertRun(id: string, marketId: string, receivedAt: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ImportRun" ("id", "market_id", "scanned_at", "received_at", "source",
       "scan_items", "series_points", "quotes", "journal_events", "journal_errors",
       "duration_ms", "status")
     VALUES (?, ?, ?, ?, 'watcher', 1, 0, 0, 0, 0, 1, 'ok')`,
    id,
    marketId,
    receivedAt,
    receivedAt
  );
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ getMarketRevision } = await import("@/lib/repositories"));
  await prisma.$executeRawUnsafe(`CREATE TABLE "ImportRun" (
    "id" TEXT PRIMARY KEY, "market_id" TEXT, "scanned_at" DATETIME,
    "received_at" DATETIME, "source" TEXT, "scan_items" INTEGER,
    "series_points" INTEGER, "quotes" INTEGER, "journal_events" INTEGER,
    "journal_errors" INTEGER, "duration_ms" INTEGER, "status" TEXT, "error" TEXT)`);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove the temporary database at ${directory}: ${String(error)}`);
  }
});

describe("getMarketRevision", () => {
  it("names the newest import run of the scope", async () => {
    await insertRun("run-old", "m1", Date.UTC(2026, 10, 8, 10));
    await insertRun("run-new", "m1", Date.UTC(2026, 10, 8, 11));
    expect(await getMarketRevision(scope)).toBe("m1:run-new");
  });

  it("ignores another market's imports", async () => {
    await insertRun("run-other", "m2", Date.UTC(2026, 10, 8, 12));
    expect(await getMarketRevision(scope)).toBe("m1:run-new");
  });

  it("moves when a journal-only import lands between scans", async () => {
    await insertRun("run-journal", "m1", Date.UTC(2026, 10, 8, 13));
    expect(await getMarketRevision(scope)).toBe("m1:run-journal");
  });

  it("has a stable revision before the market's first import", async () => {
    expect(await getMarketRevision(null)).toBe("none");
    expect(await getMarketRevision({ ...scope, id: "m3" })).toBe("m3:none");
  });
});
