// The auto-refresh revision is the market's committed data version. It is
// advanced inside the import transaction, so the poll moves with the data
// and not with a diagnostic ImportRun row that may fail or be pruned.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-market-revision-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let getMarketRevision: typeof import("@/lib/repositories").getMarketRevision;

const scope = {
  id: "m1",
  realm: "TestRealm",
  faction: "Alliance",
  cash: 0,
  character: "Tester",
  dataVersion: 7
};

beforeAll(async () => {
  ({ getMarketRevision } = await import("@/lib/repositories"));
});

afterAll(async () => {
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove the temporary database at ${directory}: ${String(error)}`);
  }
});

describe("getMarketRevision", () => {
  it("names the scope and the data version committed with its inputs", async () => {
    expect(await getMarketRevision(scope)).toBe("m1:7");
  });

  it("moves when the committed data version advances", async () => {
    expect(await getMarketRevision({ ...scope, dataVersion: 8 })).toBe("m1:8");
  });

  it("keeps two markets from sharing an empty revision", async () => {
    expect(await getMarketRevision({ ...scope, id: "m2", dataVersion: 0 })).toBe("m2:0");
  });

  it("has a stable revision before the market's first import", async () => {
    expect(await getMarketRevision(null)).toBe("none");
  });
});
