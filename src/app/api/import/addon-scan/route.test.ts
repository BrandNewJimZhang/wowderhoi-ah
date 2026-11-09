// Boundary tests for the import route. A journal-bearing scan replaces the
// whole ledger, so a mismatch between the scan's character and the
// journal's book keys must be rejected before any write. The ledger tests
// below run against a real SQLite schema because the revision invariant is
// transactional: the token must move with the data, not with the
// diagnostic ImportRun rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-import-route-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let POST: typeof import("./route").POST;
let POST_STATE: typeof import("../addon-state/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;
let marketRevision: typeof import("@/lib/market-revision").marketRevision;
let getMarketScope: typeof import("@/lib/market-scope").getMarketScope;

const scan = {
  dataVersion: 4,
  scannedAt: 1721700000,
  server: "A",
  faction: "Alliance",
  character: "Tester",
  cash: 0,
  items: {
    "1": { name: "X", minPrice: 100, marketPrice: 100, sellP: 100, quantity: 5, numAuctions: 1 }
  }
};

const emptyJournal = { books: { "A|Alliance|Tester": { e: [], dropped: 0 } } };
const journalWithEvent = {
  books: {
    "A|Alliance|Tester": {
      e: [{ k: "buy", t: 1721700001, seq: 1, itemId: 1, qty: 1, cost: 100 }],
      dropped: 0,
      nextSeq: 2
    }
  }
};

function post(payload: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/import/addon-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

function postState(payload: unknown): Promise<Response> {
  return POST_STATE(new Request("http://localhost/api/import/addon-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

async function marketRow() {
  const market = await prisma.market.findUnique({
    where: { realm_faction: { realm: "A", faction: "Alliance" } }
  });
  if (!market) throw new Error("Expected the import to create the market row");
  return market;
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { stdio: "pipe", env: { ...process.env } });
  ({ POST } = await import("./route"));
  ({ POST: POST_STATE } = await import("../addon-state/route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ marketRevision } = await import("@/lib/market-revision"));
  ({ getMarketScope } = await import("@/lib/market-scope"));
});

// SQLite releases its Windows file handle asynchronously after disconnect,
// so removing the throwaway database immediately intermittently fails with
// EPERM. Retry for a short while; a leftover temp directory after that is
// not a test failure.
async function removeDirectory(dir: string, attempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts) {
        console.warn(`Could not remove the temporary database at ${dir}: ${String(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

afterAll(async () => {
  await prisma.$disconnect();
  await removeDirectory(directory);
});

describe("POST /api/import/addon-scan revision", () => {
  it("advances the data version inside the transaction that writes the observation", async () => {
    const response = await post({ scan });
    expect(response.status).toBe(200);
    const body = await response.json() as { imported: number; marketId: string };
    expect(body.imported).toBe(1);

    const market = await marketRow();
    expect(market.id).toBe(body.marketId);
    expect(market.dataVersion).toBe(1);
    const scope = await getMarketScope();
    expect(scope?.cash).toBe(0);
    expect(scope?.character).toBe("Tester");
    expect(marketRevision(scope)).toBe(`${market.id}:1`);
    // The scan stores the core output but the game's plan owns decisions.
    expect(await prisma.decision.count({ where: { marketId: market.id } })).toBe(0);
  });

  it("does not move the version for a duplicate scan, even with a journal", async () => {
    const response = await post({ scan, journal: emptyJournal });
    expect(response.status).toBe(409);
    expect((await marketRow()).dataVersion).toBe(1);
  });

  it("moves the version when the state route commits a journal", async () => {
    const response = await postState({
      server: "A",
      faction: "Alliance",
      journal: journalWithEvent
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { changed: boolean };
    expect(body.changed).toBe(true);
    expect((await marketRow()).dataVersion).toBe(2);
  });

  it("rolls the observation and the version back when the import transaction fails", async () => {
    // Fault injection after the market update has run: the signal insert can
    // no longer succeed, so the whole transaction — including the version
    // and the estate's scanned cash — must roll back.
    await prisma.$executeRawUnsafe(`DROP TABLE "MarketSignalRow"`);
    await expect(post({
      scan: {
        ...scan,
        scannedAt: scan.scannedAt + 3600,
        cash: 999_999,
        items: {
          ...scan.items,
          "2": { name: "Y", minPrice: 200, marketPrice: 200, sellP: 200, quantity: 5, numAuctions: 1 }
        }
      }
    })).rejects.toThrow();
    const market = await marketRow();
    expect(market.dataVersion).toBe(2);
    const estate = await prisma.estate.findUnique({
      where: { marketId_scope: { marketId: market.id, scope: "character:Tester" } }
    });
    expect(estate?.cash).toBe(0);
  });
});
