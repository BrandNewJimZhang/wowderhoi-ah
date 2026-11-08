// Boundary tests for the import route's journal guard. A journal-bearing
// scan replaces the whole ledger, so a mismatch between the scan's
// character and the journal's book keys must be rejected before any write.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-import-route-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let POST: typeof import("./route").POST;

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

function post(payload: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/import/addon-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

beforeAll(async () => {
  ({ POST } = await import("./route"));
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
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
  await removeDirectory(directory);
});

describe("POST /api/import/addon-scan journal guard", () => {
  it("rejects a journal that has no book for the scanning character", async () => {
    const response = await post({
      scan,
      journal: { books: { "A|Alliance|SomeoneElse": { e: [], dropped: 0 } } }
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("A|Alliance|Tester");
  });

  it("rejects a journal-bearing scan that does not name its character", async () => {
    const response = await post({
      // JSON.stringify drops undefined, so the scan truly carries no character.
      scan: { ...scan, character: undefined },
      journal: { books: { "A|Alliance|Tester": { e: [], dropped: 0 } } }
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("must name its character");
  });
});
