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

function estate(revision: number, carried: number, observedAt = NOW, character = "Tester") {
  return {
    v: 1,
    revision,
    observedAt,
    scopes: {
      [`character:${character}`]: {
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
        items: {} as Record<string, Record<string, { qty: number; slots: number }>>
      }
    }
  };
}

function estateWithAccount(revision: number, carried: number, listed: number, observedAt = NOW) {
  const payload = estate(revision, carried, observedAt);
  payload.scopes.account.coverage = { account_bank: "unobserved", listed: "observed" };
  payload.scopes.account.items = { "2770": { listed: { qty: listed, slots: 1 } } };
  return payload;
}

function book(character: string, events: unknown[], nextSeq = events.length + 1, epoch?: number) {
  return {
    books: {
      [`A|Alliance|${character}`]: {
        e: events,
        dropped: 0,
        nextSeq,
        ...(epoch === undefined ? {} : { epoch })
      }
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

  it("requires the state payload to name its market directly", async () => {
    const response = await post("state", {
      // A scan document is not the state domain's identity; the watcher
      // sends server and faction as top-level fields.
      scan: { server: "A", faction: "Alliance" },
      estate: estate(1, 1)
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/must name its server and faction/);
  });

  it("rejects an estate document from another format version", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      estate: { ...estate(9, 1), v: 2 }
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/unsupported estate version/);
  });

  it("rejects a coverage map the terminal does not understand", async () => {
    const payload = estate(9, 1);
    (payload.scopes["character:Tester"].coverage as unknown as Record<string, string>).void_storage = "observed";
    const response = await post("state", { server: "A", faction: "Alliance", estate: payload });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/unknown coverage key/);
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

  it("accepts a re-created estate whose counter restarted", async () => {
    // The revision is the addon's local counter. Reinstalling the addon or
    // clearing SavedVariables restarts it at 1, so a smaller number with a
    // newer observation is fresh state, not a delayed document. An older
    // observation is still stale and must not regress the terminal.
    await post("scan", {
      scan: { ...scan, server: "Reset", faction: "Horde", character: "Resty", scannedAt: NOW - 1000 }
    });
    await post("state", {
      server: "Reset", faction: "Horde",
      estate: estate(5, 5, NOW - 500, "Resty")
    });
    const restarted = await post("state", {
      server: "Reset", faction: "Horde",
      estate: estate(1, 7, NOW - 100, "Resty")
    });
    expect((await restarted.json() as { changed: boolean }).changed).toBe(true);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "Reset", faction: "Horde" } } });
    expect(await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Resty", itemId: 2589 }
    })).toMatchObject({ qty: 7 });

    const delayed = await post("state", {
      server: "Reset", faction: "Horde",
      estate: estate(4, 9, NOW - 200, "Resty")
    });
    expect((await delayed.json() as { changed: boolean }).changed).toBe(false);
    expect(await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Resty", itemId: 2589 }
    })).toMatchObject({ qty: 7 });
  });

  it("accepts a restarted counter that collides with the old one", async () => {
    // The new install's first book is revision 1, which can equal the old
    // row's revision exactly. A re-send carries the same observation time;
    // a re-created book carries a later one, so time is the tie-breaker.
    await post("scan", {
      scan: { ...scan, server: "Reset2", faction: "Horde", character: "Resty", scannedAt: NOW - 1000 }
    });
    await post("state", {
      server: "Reset2", faction: "Horde",
      estate: estate(1, 5, NOW - 500, "Resty")
    });
    const recreated = await post("state", {
      server: "Reset2", faction: "Horde",
      estate: estate(1, 7, NOW - 100, "Resty")
    });
    expect((await recreated.json() as { changed: boolean }).changed).toBe(true);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "Reset2", faction: "Horde" } } });
    expect(await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Resty", itemId: 2589 }
    })).toMatchObject({ qty: 7 });
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

  it("applies a corrected fact without appending a second one", async () => {
    // The client books a purchase at an estimated price, then the UI path
    // reports the exact cost for the same sequence. The terminal must update
    // the fact in place: the holding and the trade are projections of it.
    // A separate character and item keep the correction from changing the
    // ledger the earlier tests assert on.
    const events = [
      { k: "buy", t: NOW - 100, seq: 20, itemId: 7777, qty: 5, cost: 5000 },
      { k: "sold", t: NOW - 50, seq: 21, itemId: 7777, qty: 2, price: 1000, fee: 100, auctionID: 8 }
    ];
    const first = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Corrector", events, 22)
    });
    expect(first.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const before = await prisma.trade.findFirst({
      where: { marketId: market!.id, character: "Corrector", sourceFactId: "Corrector|seq|21" }
    });
    expect(before?.pnl).toBe(-100);

    const corrected = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Corrector", [
        { ...events[0], cost: 4000 },
        events[1]
      ], 22)
    });
    expect(corrected.status).toBe(200);
    expect((await corrected.json() as { changed: boolean }).changed).toBe(true);
    expect(await prisma.journalFact.count({
      where: { marketId: market!.id, character: "Corrector", seq: 20 }
    })).toBe(1);
    const trade = await prisma.trade.findFirst({
      where: { marketId: market!.id, character: "Corrector", sourceFactId: "Corrector|seq|21" }
    });
    expect(trade).toMatchObject({ qty: 2, fee: 100, pnl: 300, basisKnown: true });
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Corrector", itemId: 7777 }
    });
    expect(holding).toMatchObject({ knownQty: 3, costBasis: 2400 });
    const fact = await prisma.journalFact.findUnique({
      where: { marketId_character_epoch_seq: { marketId: market!.id, character: "Corrector", epoch: 0, seq: 20 } }
    });
    expect((fact?.payload as { cost: number }).cost).toBe(4000);
  });

  it("replays the newest book after SavedVariables is cleared", async () => {
    // Clearing SavedVariables restarts the sequence at 1. The epoch is the
    // book's identity: without it the terminal would match the new seq 1
    // and 2 against the old facts, insert nothing, and keep replaying a
    // ledger the client no longer has.
    const first = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Reborn", [
        { k: "buy", t: NOW - 100, seq: 1, itemId: 9999, qty: 2, cost: 2000 },
        { k: "sold", t: NOW - 50, seq: 2, itemId: 9999, qty: 2, price: 3000, fee: 300, auctionID: 21 }
      ], 3)
    });
    expect(first.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });

    const second = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Reborn", [
        { k: "buy", t: NOW - 10, seq: 1, itemId: 9999, qty: 3, cost: 6000 },
        { k: "sold", t: NOW - 5, seq: 2, itemId: 9999, qty: 1, price: 2000, fee: 200, auctionID: 22 }
      ], 3, 200)
    });
    expect(second.status).toBe(200);
    expect(await prisma.journalFact.count({ where: { marketId: market!.id, character: "Reborn" } })).toBe(4);
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Reborn", itemId: 9999 }
    });
    // Only the newest book defines the live ledger: buy 3 at 2,000 each,
    // sell 1, leaving 2 units at a 4,000 basis.
    expect(holding).toMatchObject({ qty: 2, knownQty: 2, costBasis: 4000 });
    expect(await prisma.trade.count({ where: { marketId: market!.id, character: "Reborn" } })).toBe(2);
    const newest = await prisma.trade.findFirst({
      where: { marketId: market!.id, character: "Reborn", sourceFactId: { contains: "epoch:200" } }
    });
    expect(newest).not.toBeNull();

    // A new book can be empty right after the reset. Its existence must
    // still switch the live ledger, or the terminal keeps showing the old
    // book's positions until the first action.
    const cleared = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Reborn", [], 1, 300)
    });
    expect(cleared.status).toBe(200);
    expect(await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Reborn", itemId: 9999 }
    })).toBeNull();
  });

  it("labels a trade the ledger could not price", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Tester", [
        { k: "sold", t: NOW - 40, seq: 3, itemId: 9999, qty: 4, price: 1200, fee: 240, auctionID: 11 }
      ], 4)
    });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const trade = await prisma.trade.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 9999 }
    });
    // The revenue is real, the profit is not: the row must say so.
    expect(trade).toMatchObject({ qty: 4, pnl: 4560, basisKnown: false });
  });

  it("keeps every partial fill of one posting as its own trade", async () => {
    const events = [
      { k: "buy", t: NOW - 200, seq: 1, itemId: 2592, qty: 10, cost: 1000 },
      { k: "post", t: NOW - 190, seq: 2, auctionID: 99, itemId: 2592, qty: 10, price: 200, deposit: 100 },
      { k: "sold", t: NOW - 180, seq: 3, auctionID: 99, itemId: 2592, qty: 4, price: 200, fee: 0 },
      { k: "sold", t: NOW - 170, seq: 4, auctionID: 99, itemId: 2592, qty: 6, price: 200, fee: 0 }
    ];
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Partial", events, 5)
    });
    expect(response.status).toBe(200);
    // A commodity listing fills in pieces. Both mails name the same
    // auctionID, so keying the trade by the posting overwrote the first fill.
    expect((await response.json() as { trades: number }).trades).toBe(2);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const rows = await prisma.trade.findMany({
      where: { marketId: market!.id, character: "Partial" }
    });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.qty, 0)).toBe(10);
  });

  it("keeps a checkpoint trade's identity when older trades are pruned", async () => {
    // A checkpoint drops trades older than the retention window. If the
    // fact identity were the trade's array position, every surviving trade
    // would shift and be inserted a second time.
    const trade = (seq: number, itemId: number) => ({
      t: NOW - 100 + seq, seq, itemId, qty: 1, price: 10, fee: 0, basis: 5,
      basisKnown: true, pnl: 5, channel: "vendor", inferred: false,
      observedAt: NOW - 100 + seq, censored: false
    });
    const checkpoint = (throughSeq: number, trades: unknown[], throughSeqNext: number) => ({
      books: {
        "A|Alliance|Checkpointer": {
          e: [],
          dropped: 0,
          nextSeq: throughSeqNext,
          checkpoint: {
            throughSeq,
            state: {
              lots: {},
              openPosts: {},
              trades,
              capital: { escrow: 0, realized: 0, fees: 0, depositsLost: 0, cashDelta: 0 }
            }
          }
        }
      }
    });
    expect((await post("state", {
      server: "A", faction: "Alliance",
      journal: checkpoint(10, [trade(1, 2589)], 11)
    })).status).toBe(200);
    expect((await post("state", {
      server: "A", faction: "Alliance",
      journal: checkpoint(20, [trade(2, 2592), trade(1, 2589)], 21)
    })).status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    expect(await prisma.trade.count({
      where: { marketId: market!.id, character: "Checkpointer" }
    })).toBe(2);
  });

  it("marks a holding whose cost was only estimated", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Tester", [
        { k: "buy", t: NOW - 30, seq: 5, itemId: 8888, qty: 2, cost: 2000, priceSource: "estimated" }
      ], 6)
    });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 8888 }
    });
    expect(holding).toMatchObject({ knownQty: 2, unknownQty: 0, costKnown: false });
  });

  it("rebuilds holdings when only the estate moves", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      estate: estate(2, 8)
    });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 2589 }
    });
    expect(holding).toMatchObject({ qty: 8, carriedQty: 8, knownQty: 3, unknownQty: 5 });
  });

  it("keeps two characters' holdings and trades apart", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Alt", [{ k: "buy", t: NOW - 10, seq: 1, itemId: 2770, qty: 1, cost: 500 }])
    });
    expect(response.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    expect(await prisma.holding.count({
      where: { marketId: market!.id, character: "Tester", itemId: 2589 }
    })).toBe(1);
    const alt = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Alt", itemId: 2770 }
    });
    expect(alt?.knownQty).toBe(1);
  });

  it("moves account-scoped postings to the character whose scan is active", async () => {
    const market = await prisma.market.findUnique({
      where: { realm_faction: { realm: "A", faction: "Alliance" } }
    });
    // Tester is the active scan, so the account's posting belongs to its
    // holding row.
    await post("state", {
      server: "A", faction: "Alliance",
      estate: estateWithAccount(3, 8, 2)
    });
    const tester = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 2770 }
    });
    expect(tester?.listedQty).toBe(2);

    // A scan by Alt makes Alt the active character. The posting must leave
    // Tester's row, or the portfolio would count it twice.
    const response = await post("scan", {
      scan: { ...scan, scannedAt: NOW + 60, character: "Alt" }
    });
    expect(response.status).toBe(200);
    const testerAfter = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 2770 }
    });
    expect(testerAfter?.listedQty ?? 0).toBe(0);
    const alt = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Alt", itemId: 2770 }
    });
    expect(alt?.listedQty).toBe(2);
  });

  it("attributes account-scoped stock to the character whose estate was observed last", async () => {
    const market = await prisma.market.findUnique({
      where: { realm_faction: { realm: "A", faction: "Alliance" } }
    });
    // The newest scan still belongs to Alt. Tester's estate arrives later
    // without a scan; the account's posting must follow the character whose
    // state the page header names, not the last scan.
    await post("state", {
      server: "A", faction: "Alliance",
      estate: estateWithAccount(4, 8, 2, NOW + 120)
    });
    const tester = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Tester", itemId: 2770 }
    });
    expect(tester?.listedQty).toBe(2);
    const alt = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Alt", itemId: 2770 }
    });
    expect(alt?.listedQty ?? 0).toBe(0);
  });

  it("does not rebuild holdings from an older journal book", async () => {
    await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Alt", [{ k: "buy", t: NOW, seq: 2, itemId: 2770, qty: 2, cost: 1000 }], 3)
    });
    const older = await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Alt", [{ k: "buy", t: NOW - 5, seq: 1, itemId: 2770, qty: 1, cost: 500 }], 2)
    });
    expect(older.status).toBe(200);
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const holding = await prisma.holding.findFirst({
      where: { marketId: market!.id, character: "Alt", itemId: 2770 }
    });
    // Holdings replay the facts persisted for the character, not only the
    // events in the incoming (possibly partial) book: seq 1 bought 1 and
    // seq 2 bought 2.
    expect(holding?.qty).toBe(3);
    // The stale delivery still contributes its missing fact.
    expect(await prisma.journalFact.count({ where: { marketId: market!.id, character: "Alt" } })).toBe(2);
  });

  it("attaches an adoption that arrived before the plan", async () => {
    const revision = "A|Alliance|adopt:1:1";
    const decisionId = `${revision}:2589:sell`;
    await post("state", {
      server: "A", faction: "Alliance",
      journal: book("Adopter", [{ k: "adopt", t: NOW, seq: 1, id: decisionId }])
    });
    await post("state", {
      server: "A", faction: "Alliance",
      plan: {
        revision,
        observedAt: NOW,
        steps: [{ kind: "sell", itemId: 2589, qty: 1, expectedNet: 100 }],
        resources: {},
        unplanned: []
      }
    });
    const decision = await prisma.decision.findFirst({ where: { decisionId } });
    expect(decision?.adoptedAt?.getTime()).toBe(NOW * 1000);
  });

  it("rejects a plan step that is neither a buy nor a sell", async () => {
    const response = await post("state", {
      server: "A", faction: "Alliance",
      plan: {
        revision: "A|Alliance|invalid:1:1",
        observedAt: NOW,
        steps: [{ kind: "transfer", itemId: 2589, qty: 1 }],
        resources: {},
        unplanned: []
      }
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/not buy or sell/);
    expect(await prisma.plan.count({ where: { revision: "A|Alliance|invalid:1:1" } })).toBe(0);
  });

  it("stores a plan once and writes its decisions immutably", async () => {
    const revision = `A|Alliance|${NOW}:1:2`;
    const plan = {
      revision,
      character: "Tester",
      estateRevision: 1,
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
    expect(stored?.character).toBe("Tester");
    const decision = await prisma.decision.findFirst({ where: { decisionId: `${revision}:2589:buy` } });
    expect(decision?.decisionId).toBe(`${revision}:2589:buy`);

    // A re-sent plan does not rewrite the prediction.
    await post("state", {
      server: "A", faction: "Alliance",
      plan: { ...plan, steps: [{ ...plan.steps[0], expectedNet: 999 }] }
    });
    const unchanged = await prisma.decision.findFirst({ where: { decisionId: `${revision}:2589:buy` } });
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

  it("leaves exactly one current plan when two are minted in one second", async () => {
    const first = "A|Alliance|same-second:1:1";
    const second = "A|Alliance|same-second:1:2";
    const base = {
      observedAt: NOW,
      steps: [{ kind: "buy", itemId: 2589, qty: 1, expectedNet: 10 }],
      resources: {},
      unplanned: []
    };
    await post("state", { server: "A", faction: "Alliance", plan: { ...base, revision: first } });
    await post("state", { server: "A", faction: "Alliance", plan: { ...base, revision: second } });
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm: "A", faction: "Alliance" } } });
    const rows = await prisma.plan.findMany({ where: { marketId: market!.id } });
    // A delayed plan is stored for history, never as a second current one.
    expect(rows.filter((row) => row.supersededAt === null)).toHaveLength(1);
    const current = rows.find((row) => row.supersededAt === null);
    expect(current?.revision).toBe(second);
  });
});
