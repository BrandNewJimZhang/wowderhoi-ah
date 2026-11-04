import { describe, expect, it } from "vitest";
import { parseSavedVariables } from "@/lib/addon-scan";
import { parseJournal, replayJournal, type JournalEvent } from "@/lib/journal";
import { loadAddon } from "../../addon/test/wow-lua";

const EVENTS: JournalEvent[] = [
  { k: "buy", t: 100, itemId: 2589, qty: 10, cost: 10000 },
  { k: "buy", t: 110, itemId: 2589, qty: 10, cost: 20000 },
  { k: "post", t: 120, auctionID: 7, itemId: 2589, qty: 15, price: 1500, duration: 24, deposit: 500 },
  { k: "sold", t: 130, auctionID: 7, itemId: 2589, qty: 15, price: 1500, fee: 1125 },
  { k: "vendor", t: 140, itemId: 2589, qty: 3, paid: 4000 },
  { k: "post", t: 150, auctionID: 8, itemId: 2589, qty: 2, price: 1600, duration: 24, deposit: 300 },
  { k: "expire", t: 160, auctionID: 8 },
  { k: "buy", t: 170, itemId: 1000, qty: 5, cost: 5000 },
  { k: "de", t: 180, itemId: 1000, qty: 5, outputs: [{ itemId: 2000, qty: 2 }, { itemId: 2001, qty: 1 }] }
];

describe("replayJournal", () => {
  it("replays FIFO, fees, deposits and conversions", () => {
    const state = replayJournal(EVENTS);
    // 15 sold: 10 @ 1000 + 5 @ 2000 = 20000; 22500 - 1125 - 20000 = 1375.
    // 3 vendor: 3 @ 2000 = 6000; 4000 - 6000 = -2000.
    expect(state.capital.realized).toBe(-625);
    expect(state.capital.fees).toBe(1125);
    expect(state.capital.depositsLost).toBe(300);
    expect(state.capital.escrow).toBe(0);
    expect(state.positions[2589]).toEqual({ qty: 2, cost: 4000 });
    expect(state.positions[2000]).toEqual({ qty: 2, cost: 3333 });
    expect(state.positions[2001]).toEqual({ qty: 1, cost: 1667 });
    expect(state.trades).toHaveLength(2);
    expect(state.trades[0].inferred).toBe(false);
  });

  it("labels an inferred sale and books it at the posted price", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1, qty: 1, cost: 100 },
      { k: "post", t: 2, auctionID: 1, itemId: 1, qty: 1, price: 200, duration: 24, deposit: 10 },
      { k: "sold", t: 3, auctionID: 1, itemId: 1, qty: 1, price: 200, fee: 10, inferred: true }
    ]);
    expect(state.trades[0].inferred).toBe(true);
    expect(state.trades[0].pnl).toBe(90);
  });

  it("consumes materials when replaying a craft", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1000, qty: 10, cost: 10000 },
      { k: "craft", t: 2, itemId: 2000, qty: 2, cost: 10000, mats: [{ itemId: 1000, qty: 10 }] }
    ]);
    expect(state.positions[1000]).toBeUndefined();
    expect(state.positions[2000]).toEqual({ qty: 2, cost: 10000 });
    expect(state.errors).toHaveLength(0);
  });

  it("records a short position instead of inventing cost", () => {
    const state = replayJournal([{ k: "sold", t: 1, auctionID: 1, itemId: 9, qty: 4, price: 100, fee: 20 }]);
    expect(state.errors[0]).toMatchObject({ kind: "short_position", itemId: 9, missing: 4 });
    expect(state.capital.realized).toBe(380);
  });

  it("reports an unknown event kind instead of silently dropping it", () => {
    const state = replayJournal([{ k: "teleport", t: 1 }]);
    expect(state.errors[0]).toMatchObject({ kind: "unknown_event", name: "teleport" });
  });

  it("matches the Lua ledger for the same journal", () => {
    const fromLua = loadAddon().ledgerReplay(EVENTS) as Record<string, unknown>;
    const fromTs = replayJournal(EVENTS, "TestRealm|Alliance|Tester");
    expect(fromTs.positions).toEqual(fromLua.positions);
    // Both open-post sets are empty; Lua's empty table crosses the bridge
    // as an array, so compare the keys rather than the container shape.
    expect(Object.keys(fromTs.openPosts)).toEqual(Object.keys(fromLua.openPosts as object));
    expect(fromTs.capital).toEqual(fromLua.capital);
    expect(fromTs.trades).toEqual(fromLua.trades);
    expect(fromTs.errors).toEqual(fromLua.errors);
  });
});

describe("parseJournal", () => {
  const fixture = `
WoWderhoiAH_Journal = {
  ["v"] = 1,
  ["books"] = {
    ["TestRealm|Alliance|Tester"] = {
      ["dropped"] = 2,
      ["e"] = {
        { ["k"] = "buy", ["t"] = 100, ["itemId"] = 2589, ["qty"] = 10, ["cost"] = 10000 },
        { ["k"] = "post", ["t"] = 120, ["auctionID"] = 7, ["itemId"] = 2589, ["qty"] = 10, ["price"] = 1500, ["deposit"] = 500 },
        { ["k"] = "sold", ["t"] = 130, ["auctionID"] = 7, ["itemId"] = 2589, ["qty"] = 10, ["price"] = 1500, ["fee"] = 750, ["inferred"] = true }
      }
    }
  }
}`;

  it("reads one book per character and preserves the dropped count", () => {
    const parsed = parseSavedVariables(fixture);
    const books = parseJournal(parsed.WoWderhoiAH_Journal);
    expect(books).toHaveLength(1);
    expect(books[0].key).toBe("TestRealm|Alliance|Tester");
    expect(books[0].dropped).toBe(2);
    expect(books[0].events.map((event) => event.k)).toEqual(["buy", "post", "sold"]);
    expect(books[0].events[2].inferred).toBe(true);
    expect(replayJournal(books[0].events).capital.realized).toBe(4250);
  });

  it("returns no books for an absent journal", () => {
    expect(parseJournal(undefined)).toEqual([]);
    expect(parseJournal({})).toEqual([]);
  });
});
