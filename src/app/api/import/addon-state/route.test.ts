// The state route carries everything that changes between scans. Its
// contracts are idempotency (a re-sent document is a no-op), character
// isolation (importing B must not erase A) and append-only facts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "wah-state-route-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;

let POST_STATE: typeof import("./route").POST;
let POST_SCAN: typeof import("../addon-scan/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;

const NOW = 1721700000;
const scan = {
  dataVersion: 4,
  scannedAt: NOW,
  server: "A",
  faction: "Alliance",
  character: "Tester",
  cash: 10000,
  bagSlots: 10,
  items: {
    "2589": { name: "Linen", minPrice: 100, marketPrice: 100, sellP: 100, quantity: 5, numAuctions: 1 }
  }
};

function post(path: string, payload: unknown): Promise<Response> {
  const handler = path === "state" ? POST_STATE : POST_SCAN;
  return handler(new Request(`http://localhost/api/import/${path === "state" ? "addon-state" : "addon-scan"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

function estate(revision: number, carried: number) {
  return {
    v: 1,
    revision,
    observedAt: NOW,
    scopes: {
      "character:Tester": {
        kind: "character",
        revision,
        cash: 10000,
        freeSlots: 10,
        coverage: {
          carried: "observed", bank: "unobserved", mail: "unobserved", money: "observed"
        },
        items: { "2589": { carried: { qty: carried, slots: 1 } } }
      },
      account: {
        kind: "account",
        revision,
        coverage: { account_bank: "unobserved", listed: "unobserved" },
        items: {}
      }
    }
  };
}

function book(character: string, events: unknown[], nextSeq = events.length + 1) {
  return {
    books: {
      [`A|Alliance|${character}`]: { e: events, dropped: 0, nextSeq }
    }
  };
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { stdio: "pipe", env: { ...process.env } });
  ({ POST: POST_STATE } = await import("./route"));
  ({ POST: POST_SCAN } = await import("../addon-scan/route"));
  ({ prisma } = await import("@/lib/prisma"));
});

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

describe("POST /api/import/addon-state", () => {
  it("creates the market with a scan, then applies an estate revision", async () => {
    expect((await post("scan", { scan })).status).toBe(200);
    const response = await post("state", { server: "A", faction: "Alliance", estate: estate(1, 5) });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const rows = await prisma.estate.findMany({ where: { marketId: market!.id }, include: { items: true } });
    expect(rows).toHaveLength(2);
    const character = rows.find((row) => row.scope === "character:Tester")!;
    expect(character.cash).toBe(10000);
    expect(character.items[0]).toMatchObject({ itemId: 2589, location: "carried", qty: 5 });
  });

  it("ignores an estate revision that does not advance", async () => {
    const response = await post("state", { server: "A", faction: "Alliance", estate: estate(1, 99) });
    expect(response.status).toBe(200);
    const body = await response.json() as { changed: boolean };
    expect(body.changed).toBe(false);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const item = await prisma.estateItem.findFirst({ where: { estate: { marketId: market!.id, scope: "character:Tester" } } });
    expect(item?.qty).toBe(5);
  });

  it("applies journal facts once and derives the holding", async () => {
    const events = [
      { k: "buy", t: NOW - 100, seq: 1, itemId: 2589, qty: 5, cost: 5000 },
      { k: "sold", t: NOW - 50, seq: 2, itemId: 2589, qty: 2, price: 1000, fee: 100, auctionID: 7 }
    ];
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Tester", events)
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { journalEvents: number; trades: number };
    expect(body.journalEvents).toBe(2);
    expect(body.trades).toBe(1);

    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    expect(await prisma.journalFact.count({ where: { marketId: market!.id } })).toBe(2);
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 2589 }
    });
    expect(holding).toMatchObject({ qty: 5, carriedQty: 5, knownQty: 3, unknownQty: 2, missingQty: 0 });
    expect(await prisma.trade.count({ where: { marketId: market!.id, character: "Tester" } })).toBe(1);

    // Re-sending the same book is a no-op.
    const again = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Tester", events)
    });
    expect((await again.json() as { changed: boolean }).changed).toBe(false);
    expect(await prisma.journalFact.count({ where: { marketId: market!.id } })).toBe(2);
    expect(await prisma.trade.count({ where: { marketId: market!.id, character: "Tester" } })).toBe(1);
  });

  it("keeps two characters' holdings and trades apart", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Alt", [{ k: "buy", t: NOW - 10, seq: 1, itemId: 2770, qty: 1, cost: 500 }])
    });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    expect(await prisma.holding.count({ where: { marketId: market!.id, character: "Tester" } })).toBe(1);
    const alt = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Alt", itemId: 2770 }
    });
    expect(alt?.knownQty).toBe(1);
  });

  it("stores a plan once and writes its decisions immutably", async () => {
    const revision = `A|Alliance|${NOW}:1:2`;
    const plan = {
      revision,
      estateRevision: 1,
      ledgerRevision: 2,
      observedAt: NOW,
      steps: [{
        kind: "buy", itemId: 2589, qty: 5, allocQty: 5, allocUnitPrice: 800,
        expectedNet: 100, fillProb: 0.5, fillBasis: "prior", reason: "test"
      }],
      resources: { cash: 10000 },
      unplanned: []
    };
    const response = await post("state", { server: "A", faction: "Alliance", plan });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const stored = await prisma.plan.findUnique({
      where: { marketId_revision: { marketId: market!.id, revision } }
    });
    expect(stored).not.toBeNull();
    const decision = await prisma.decision.findFirst({ where: { planRevision: revision } });
    expect(decision?.decisionId).toBe(`${revision}:2589:buy`);

    // A re-sent plan does not rewrite the prediction.
    await post("state", {
      server: "A", faction: "Alliance",
      plan: { ...plan, steps: [{ ...plan.steps[0], expectedNet: 999 }] }
    });
    const unchanged = await prisma.decision.findFirst({ where: { planRevision: revision } });
    expect(unchanged?.expectedNet).toBe(100);

    // A delayed older plan is stored for history but never supersedes the
    // plan the player is actually looking at.
    await post("state", {
      server: "A", faction: "Alliance",
      plan: { ...plan, revision: "A|Alliance|older", observedAt: NOW - 100 }
    });
    const old = await prisma.plan.findUnique({
      where: { marketId_revision: { marketId: market!.id, revision: "A|Alliance|older" } }
    });
    expect(old?.supersededAt).not.toBeNull();
    const current = await prisma.plan.findUnique({
      where: { marketId_revision: { marketId: market!.id, revision } }
    });
    expect(current?.supersededAt).toBeNull();
  });
});
