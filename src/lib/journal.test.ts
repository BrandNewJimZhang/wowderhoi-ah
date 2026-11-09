import { describe, expect, it } from "vitest";
import { parseSavedVariables } from "@/lib/addon-scan";
import { bookForCharacter, checkpointOf, journalRevision, parseJournal, replayJournal, type JournalEvent } from "@/lib/journal";
import { loadAddon } from "../../addon/test/wow-lua";

const EVENTS: JournalEvent[] = [
  { k: "buy", t: 100, itemId: 2589, qty: 10, cost: 10000 },
  { k: "buy", t: 110, itemId: 2589, qty: 10, cost: 20000 },
  { k: "post", t: 120, auctionID: 7, itemId: 2589, qty: 15, price: 1500, deposit: 500 },
  { k: "sold", t: 130, auctionID: 7, itemId: 2589, qty: 15, price: 1500, fee: 1125, censored: true },
  { k: "vendor", t: 140, itemId: 2589, qty: 3, paid: 4000 },
  { k: "post", t: 150, auctionID: 8, itemId: 2589, qty: 2, price: 1600, deposit: 300 },
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
    expect(state.trades[0].listedAt).toBe(120);
    expect(state.trades[0].observedAt).toBe(130);
    expect(state.trades[0].censored).toBe(true);
  });

  it("prices a craft from its materials, never the reported cost", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1000, qty: 10, cost: 1000 },
      { k: "craft", t: 2, itemId: 2000, qty: 2, cost: 99999, mats: [{ itemId: 1000, qty: 10 }] }
    ]);
    expect(state.positions[2000]).toEqual({ qty: 2, cost: 1000 });
  });

  it("keeps a posting open when a sale only fills part of it", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1, qty: 20, cost: 2000 },
      { k: "post", t: 2, auctionID: 5, itemId: 1, qty: 20, price: 100, deposit: 300 },
      { k: "sold", t: 3, auctionID: 5, itemId: 1, qty: 5, price: 100, fee: 25 }
    ]);
    expect(state.openPosts["5"].qty).toBe(15);
    expect(state.capital.escrow).toBe(300);
    expect(state.positions[1].qty).toBe(15);
  });

  it("labels an inferred sale and books it at the posted price", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1, qty: 1, cost: 100 },
      { k: "post", t: 2, auctionID: 1, itemId: 1, qty: 1, price: 200, deposit: 10 },
      { k: "sold", t: 3, auctionID: 1, itemId: 1, qty: 1, price: 200, fee: 10, inferred: true }
    ]);
    expect(state.trades[0].inferred).toBe(true);
    expect(state.trades[0].pnl).toBe(90);
  });

  it("books fractional unit prices as whole copper", () => {
    // Commodity tiers are buyout/count, so a sale can carry 100/3 copper.
    // The client posts in whole copper and the trade table stores integers:
    // a fractional row must never reach the import and fail it wholesale.
    const events: JournalEvent[] = [
      { k: "buy", t: 1, itemId: 1, qty: 3, cost: 100 },
      { k: "buy", t: 1, itemId: 2, qty: 3, cost: 100 },
      { k: "post", t: 2, auctionID: 9, itemId: 1, qty: 3, price: 100 / 3, deposit: 10 },
      { k: "sold", t: 3, auctionID: 9, itemId: 1, qty: 3, price: 100 / 3, fee: 5 },
      { k: "vendor", t: 4, itemId: 2, qty: 3, paid: 100 }
    ];
    const state = replayJournal(events);
    expect(state.trades[0].price).toBe(33);
    expect(state.trades[0].pnl).toBe(-5);
    expect(state.trades[1].price).toBe(33);
    expect(state.trades[1].pnl).toBe(0);
    expect(state.trades.every((trade) => Number.isInteger(trade.price) && Number.isInteger(trade.pnl) && Number.isInteger(trade.fee))).toBe(true);
    // The Lua ledger rounds identically, so the projections stay equal.
    const fromLua = loadAddon().ledgerReplay(events) as { trades: unknown };
    expect(state.trades).toEqual(fromLua.trades);
  });

  it("upgrades an inferred sale when the mailbox confirms it", () => {
    const state = replayJournal([
      { k: "buy", t: 1, itemId: 1, qty: 2, cost: 200 },
      { k: "post", t: 2, auctionID: 4, itemId: 1, qty: 2, price: 300, deposit: 10 },
      { k: "sold", t: 3, auctionID: 4, itemId: 1, qty: 2, price: 300, fee: 30, inferred: true },
      // The mail reports a smaller commission than the inferred 5% guess.
      { k: "confirm", t: 9, auctionID: 4, itemId: 1, qty: 2, price: 300, fee: 20, censored: true }
    ]);
    // Revenue is counted once: 600 - 20 - 200. The inferred event's own
    // 30 fee is replaced, not added.
    expect(state.capital.realized).toBe(380);
    expect(state.capital.fees).toBe(20);
    expect(state.trades).toHaveLength(1);
    expect(state.trades[0].inferred).toBe(false);
    expect(state.trades[0].observedAt).toBe(9);
    expect(state.errors).toHaveLength(0);
  });

  it("reports a confirmation whose inferred sale was truncated", () => {
    const state = replayJournal([{ k: "confirm", t: 1, auctionID: 4, itemId: 1, qty: 2, price: 300, fee: 20 }]);
    expect(state.errors[0]).toMatchObject({ kind: "confirm_without_sale", itemId: 1 });
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

  it("matches the Lua ledger when confirming an inferred sale", () => {
    const events: JournalEvent[] = [
      { k: "buy", t: 1, itemId: 1, qty: 2, cost: 200 },
      { k: "post", t: 2, auctionID: 4, itemId: 1, qty: 2, price: 300, deposit: 10 },
      { k: "sold", t: 3, auctionID: 4, itemId: 1, qty: 2, price: 300, fee: 30, inferred: true },
      { k: "confirm", t: 9, auctionID: 4, itemId: 1, qty: 2, price: 300, fee: 20, censored: true }
    ];
    const fromLua = loadAddon().ledgerReplay(events) as Record<string, unknown>;
    const fromTs = replayJournal(events);
    expect(fromTs.capital).toEqual(fromLua.capital);
    expect(fromTs.trades).toEqual(fromLua.trades);
    expect(fromTs.errors).toEqual(fromLua.errors);
  });

  it("moves FIFO cost across a transfer instead of dropping the event", () => {
    // The addon records a cross-character move on both sides with
    // /wahtransfer. Ledger.lua consumes the sender's lots and re-adds them
    // on the receiver at the printed unit cost; the terminal must replay
    // the same events or its positions (and the P&L of later sales from the
    // received goods) disagree with the book the player sees in game.
    const events: JournalEvent[] = [
      { k: "buy", t: 100, itemId: 2589, qty: 10, cost: 1000 },
      { k: "transfer_out", t: 200, itemId: 2589, qty: 4, cost: 400 }
    ];
    const state = replayJournal(events);
    expect(state.positions[2589]).toEqual({ qty: 6, cost: 600 });
    expect(state.trades).toHaveLength(0);
    expect(state.errors).toHaveLength(0);

    const received = replayJournal([
      { k: "transfer_in", t: 100, itemId: 2589, qty: 4, cost: 400 }
    ]);
    expect(received.positions[2589]).toEqual({ qty: 4, cost: 400 });
    expect(received.errors).toHaveLength(0);

    const fromLua = loadAddon().ledgerReplay(events) as Record<string, unknown>;
    expect(state.positions).toEqual(fromLua.positions);
    expect(state.errors).toEqual(fromLua.errors);
  });

  it("matches the Lua ledger for the same journal", () => {
    const fromLua = loadAddon().ledgerReplay(EVENTS) as Record<string, unknown>;
    const fromTs = replayJournal(EVENTS);
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

describe("journalRevision", () => {
  const base = {
    books: {
      "TestRealm|Alliance|Main": {
        dropped: 0,
        e: [
          { k: "buy", t: 1, itemId: 2589, qty: 4, cost: 400 },
          { k: "sold", t: 2, auctionID: 7, itemId: 2589, qty: 4, price: 500, fee: 25, inferred: false }
        ]
      }
    }
  };

  it("is stable while the journal is unchanged", () => {
    expect(journalRevision(base)).toBe(journalRevision(structuredClone(base)));
  });

  it("changes when an action is appended to the same scan", () => {
    // The mailbox flushes a sale without a new scan: the revision is what
    // tells the watcher there is journal work to import even though
    // scannedAt did not move.
    const before = journalRevision(base);
    const after = journalRevision({
      books: {
        ...base.books,
        "TestRealm|Alliance|Main": {
          dropped: 0,
          e: [...base.books["TestRealm|Alliance|Main"].e, { k: "confirm", t: 3, auctionID: 7, itemId: 2589, qty: 4, price: 500, fee: 20 }]
        }
      }
    });
    expect(after).not.toBe(before);
  });

  it("changes when the oldest events are truncated", () => {
    const truncated = structuredClone(base);
    truncated.books["TestRealm|Alliance|Main"].dropped = 1;
    expect(journalRevision(truncated)).not.toBe(journalRevision(base));
  });

  it("is empty without a journal", () => {
    expect(journalRevision(undefined)).toBe("");
  });
});

describe("bookForCharacter", () => {
  const books = [
    { key: "TestRealm|Alliance|Main", events: [{ k: "buy", t: 1, itemId: 2589, qty: 4, cost: 400 }], dropped: 0 },
    { key: "TestRealm|Alliance|Alt", events: [], dropped: 0 }
  ];

  it("returns the scanning character's own book", () => {
    expect(bookForCharacter(books, "TestRealm|Alliance|Alt")?.key).toBe("TestRealm|Alliance|Alt");
  });

  it("never falls back to another character's book", () => {
    // The market ledger pairs positions with the cash of the character that
    // produced the scan. Replaying an alt's book next to this character's
    // cash would report positions that character does not hold.
    expect(bookForCharacter(books, "TestRealm|Alliance|New")).toBeNull();
    expect(bookForCharacter(books, null)).toBeNull();
  });
});

describe("journal checkpoint parity", () => {
  it("replays checkpoint plus suffix like the full history", () => {
    const full = replayJournal(EVENTS);
    const prefix = replayJournal(EVENTS.slice(0, 4));
    const checkpoint = { ...checkpointOf(prefix), throughSeq: 4 };
    const split = replayJournal(EVENTS.slice(4), checkpoint);
    expect(split.positions).toEqual(full.positions);
    expect(split.openPosts).toEqual(full.openPosts);
    expect(split.capital).toEqual(full.capital);
    // Trades in the checkpoint keep the suffix's P&L reproducible; the
    // suffix itself only appends the later sales.
    expect(split.trades.slice(0, prefix.trades.length)).toEqual(prefix.trades);
  });

  it("parses a checkpoint from SavedVariables and moves the revision", () => {
    const source = `WoWderhoiAH_Journal = { ["v"] = 2, ["books"] = { ["TestRealm|Alliance|Tester"] = { ["dropped"] = 4, ["nextSeq"] = 9, ["e"] = { { ["k"] = "buy", ["t"] = 10, ["seq"] = 9, ["itemId"] = 2589, ["qty"] = 1, ["cost"] = 100 } }, ["checkpoint"] = { ["throughSeq"] = 8, ["state"] = { ["lots"] = { [2589] = { { ["qty"] = 2, ["unitCost"] = 50, ["at"] = 1 } } }, ["openPosts"] = {}, ["trades"] = {}, ["capital"] = { ["escrow"] = 0, ["realized"] = 0, ["fees"] = 0, ["depositsLost"] = 0, ["cashDelta"] = -100 }, ["cashAnchor"] = 1000 } } } } }`;
    const parsed = parseSavedVariables(source);
    const books = parseJournal(parsed.WoWderhoiAH_Journal);
    expect(books[0].nextSeq).toBe(9);
    expect(books[0].checkpoint?.throughSeq).toBe(8);
    const state = replayJournal(books[0].events, books[0].checkpoint);
    expect(state.positions[2589]).toEqual({ qty: 3, cost: 200 });
    expect(state.capital.cashDelta).toBe(-200);
    expect(state.cashAnchor).toBe(1000);
    expect(journalRevision(parsed.WoWderhoiAH_Journal)).toContain(":9:8");
  });
});
