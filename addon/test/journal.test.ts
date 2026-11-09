// The journal is the only clean label the addon gets, and the ledger is a
// pure projection of it. These tests drive real actions through
// WAH.recordEvent and read the resulting positions, deposits and P&L.

import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function record(lua: WowLua, event: Record<string, unknown>) {
  lua.exec(`WowTest.ns.recordEvent(${toLua(event)})`);
}

describe("journal and ledger", () => {
  it("turns a buy into a position at its unit cost", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(10);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].cost")).toBe(8000);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(1);
  });

  it("stamps the append clock and censors a later observation", () => {
    const lua = loadAddon();
    const now = lua.number("time()");
    record(lua, { k: "sold", auctionID: 7, itemId: 2589, qty: 1, price: 100, observedAt: now + 60 });
    expect(lua.number("WowTest.ns.Journal.last('sold').t")).toBe(now);
    expect(lua.eval("WowTest.ns.Journal.last('sold').censored")).toBe(true);
    // The append time is the only clock; the removed copy was never read.
    expect(lua.eval("WowTest.ns.Journal.last('sold').eventTime")).toBeNull();
    record(lua, { k: "buy", itemId: 2589, qty: 1, cost: 100 });
    expect(lua.eval("WowTest.ns.Journal.last('buy').censored")).toBe(false);
  });

  it("consumes lots FIFO and realizes profit against the consumed basis", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2770, qty: 10, cost: 10000 });
    record(lua, { k: "buy", itemId: 2770, qty: 10, cost: 20000 });
    record(lua, { k: "vendor", itemId: 2770, qty: 15, paid: 30000 });
    // 10 units at 1000 + 5 at 2000 = 20000 basis; 30000 - 20000 = 10000.
    expect(lua.number("WowTest.ns.Ledger.positions()[2770].qty")).toBe(5);
    expect(lua.number("WowTest.ns.Ledger.positions()[2770].cost")).toBe(10000);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(10000);
  });

  it("consumes materials when a craft is recorded", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 1000, qty: 10, cost: 10000 });
    record(lua, { k: "craft", itemId: 2000, qty: 2, cost: 10000, mats: [{ itemId: 1000, qty: 10 }] });
    expect(lua.eval("WowTest.ns.Ledger.positions()[1000]")).toBeNull();
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].qty")).toBe(2);
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].cost")).toBe(10000);
  });

  it("refunds a deposit on sale and charges the auction fee once", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, deposit: 500 });
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(500);
    record(lua, { k: "sold", auctionID: 7, itemId: 2589, qty: 10, price: 1200, fee: 600 });
    // 12000 - 600 - 8000 = 3400; deposit is refunded, not an expense.
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(3400);
    expect(lua.number("WowTest.ns.Ledger.capital().fees")).toBe(600);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("(WowTest.ns.Ledger.positions()[2589] and WowTest.ns.Ledger.positions()[2589].qty) or 0")).toBe(0);
  });

  it("loses the deposit on expiry and keeps the goods", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 5, cost: 5000 });
    record(lua, { k: "post", auctionID: 9, itemId: 2589, qty: 5, price: 1200, deposit: 300 });
    record(lua, { k: "expire", auctionID: 9 });
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(300);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(5);
  });

  it("refunds the deposit on cancellation without realizing a trade", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 5, cost: 5000 });
    record(lua, { k: "post", auctionID: 11, itemId: 2589, qty: 5, price: 1200, deposit: 300 });
    record(lua, { k: "cancel", auctionID: 11 });
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(0);
  });

  it("allocates disenchanting cost across the outputs", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 1000, qty: 5, cost: 5000 });
    lua.exec(
      "WowTest.ns.recordEvent({ k = 'de', itemId = 1000, qty = 5, outputs = { { itemId = 2000, qty = 2 }, { itemId = 2001, qty = 1 } } })"
    );
    expect(lua.number("(WowTest.ns.Ledger.positions()[1000] and WowTest.ns.Ledger.positions()[1000].qty) or 0")).toBe(0);
    // 5000 basis over 3 outputs = 1666.67 each, rounded at the position.
    expect(lua.number("WowTest.ns.Ledger.positions()[2000].cost")).toBe(3333);
    expect(lua.number("WowTest.ns.Ledger.positions()[2001].cost")).toBe(1667);
  });

  it("replays idempotently: rebuilding twice yields the same ledger", () => {
    const lua = loadAddon();
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 3, itemId: 2589, qty: 4, price: 1200, deposit: 200 });
    record(lua, { k: "sold", auctionID: 3, itemId: 2589, qty: 4, price: 1200, fee: 240 });
    const first = lua.eval("(function() local l = WowTest.ns.Ledger.rebuild() return l.capital.realized .. '|' .. l.capital.escrow .. '|' .. l.positions[2589].qty end)()");
    const second = lua.eval("(function() local l = WowTest.ns.Ledger.rebuild() return l.capital.realized .. '|' .. l.capital.escrow .. '|' .. l.positions[2589].qty end)()");
    expect(second).toBe(first);
  });

  it("records a short position instead of inventing cost when history predates the addon", () => {
    const lua = loadAddon();
    record(lua, { k: "sold", auctionID: 1, itemId: 2589, qty: 4, price: 1200, fee: 240 });
    expect(lua.number("WoWderhoiAH_Ledger.errors[1].kind == 'short_position' and 1 or 0")).toBe(1);
    // No basis was invented: the whole revenue is realized, but the trade
    // says the profit is not a number the ledger can prove.
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(4560);
    expect(lua.number("WowTest.ns.Ledger.current().trades[1].basisKnown == false and 1 or 0")).toBe(1);
  });

  it("rejects an unknown event kind at the write boundary", () => {
    const lua = loadAddon();
    expect(() => lua.exec("WowTest.ns.Journal.append({ k = 'teleport' })")).toThrow(/unknown event/i);
  });

  it("coalesces journal writes into one delayed save", () => {
    const lua = loadAddon();
    lua.exec("WowTest.savedCount = 0");
    record(lua, { k: "buy", itemId: 2589, qty: 1, cost: 100 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 1, price: 200, deposit: 10 });
    // Both events queue one save, not two: a crafting spree or a mailbox
    // sweep must not rewrite SavedVariables per event.
    expect(lua.number("WowTest.savedCount")).toBe(0);
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.savedCount")).toBe(1);
    record(lua, { k: "cancel", auctionID: 7, refund: 10 });
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.savedCount")).toBe(2);
  });

  it("lets an immediate save supersede the queued one", () => {
    const lua = loadAddon();
    lua.exec("WowTest.savedCount = 0");
    record(lua, { k: "buy", itemId: 2589, qty: 1, cost: 100 });
    // The mailbox and the scan call WAH.flush directly; the queued timer
    // must not write the same state a second time.
    lua.exec("WowTest.ns.flush()");
    lua.exec("WowTest.runTimers()");
    expect(lua.number("WowTest.savedCount")).toBe(1);
  });
});

describe("journal checkpoint", () => {
  it("compacts the oldest prefix without changing positions or capital", () => {
    const lua = loadAddon();
    lua.exec(`
      WowTest.ns.Journal.CAP = 6
      WowTest.ns.Journal.COMPACT_KEEP = 3
      WowTest.allEvents = {}
      local function add(event)
        WowTest.ns.recordEvent(event)
        WowTest.allEvents[#WowTest.allEvents + 1] = event
      end
      add({ k = "buy", itemId = 2589, qty = 10, cost = 10000 })
      add({ k = "buy", itemId = 2589, qty = 10, cost = 20000 })
      add({ k = "post", auctionID = 7, itemId = 2589, qty = 5, price = 1500, deposit = 100 })
      add({ k = "sold", auctionID = 7, itemId = 2589, qty = 5, price = 1500, fee = 100 })
      add({ k = "buy", itemId = 2770, qty = 4, cost = 4800 })
      add({ k = "post", auctionID = 8, itemId = 2770, qty = 4, price = 1600, deposit = 200 })
      add({ k = "vendor", itemId = 2589, qty = 2, paid = 4000 })
      add({ k = "buy", itemId = 2770, qty = 3, cost = 1500 })
    `);
    expect(lua.number("WowTest.ns.Journal.book().checkpoint == nil and 0 or 1")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(4);
    const same = lua.number(`(function()
      local full = WowTest.ns.Ledger.replay(WowTest.allEvents, "TestRealm|Alliance|Tester")
      local compact = WowTest.ns.Ledger.current()
      local function samePositions()
        for itemId, position in pairs(full.positions) do
          local other = compact.positions[itemId]
          if not other or other.qty ~= position.qty or other.cost ~= position.cost then return false end
        end
        for itemId in pairs(compact.positions) do
          if not full.positions[itemId] then return false end
        end
        return true
      end
      local function sameCapital()
        for field, value in pairs(full.capital) do
          if compact.capital[field] ~= value then return false end
        end
        return true
      end
      local function samePosts()
        for key, post in pairs(full.openPosts) do
          local other = compact.openPosts[key]
          if not other or other.qty ~= post.qty then return false end
        end
        for key in pairs(compact.openPosts) do
          if not full.openPosts[key] then return false end
        end
        return true
      end
      return samePositions() and sameCapital() and samePosts() and 1 or 0
    end)()`);
    expect(same).toBe(1);
  });

  it("continues the sequence after a compaction", () => {
    const lua = loadAddon();
    lua.exec(`
      WowTest.ns.Journal.CAP = 3
      WowTest.ns.Journal.COMPACT_KEEP = 1
      for index = 1, 5 do
        WowTest.ns.recordEvent({ k = "buy", itemId = 2589, qty = 1, cost = 100 })
      end
    `);
    const lastSeq = lua.number("WowTest.ns.Journal.last('buy').seq");
    expect(lastSeq).toBe(5);
    expect(lua.number("WowTest.ns.Journal.revision()")).toBe(5);
  });
});

describe("journal book identity", () => {
  it("stamps each new book with a later epoch", () => {
    const lua = loadAddon();
    const before = lua.number("WowTest.ns.Journal.book().epoch");
    expect(before).toBeGreaterThan(0);
    // Clearing SavedVariables starts a new book whose sequence begins at 1
    // again; the epoch is what keeps those facts from looking like the old
    // book's already-imported ones.
    lua.exec("WowTest.advance(10)");
    lua.exec(`_G["WoWderhoiAH_Journal"] = nil`);
    lua.exec("WowTest.ns.Journal.ensure()");
    expect(lua.number("WowTest.ns.Journal.book().epoch")).toBeGreaterThan(before);
  });
});

describe("journal checkpoint composition", () => {
  it("keeps the older basis across repeated compactions", () => {
    const lua = loadAddon();
    lua.exec(`
      WowTest.ns.Journal.CAP = 4
      WowTest.ns.Journal.COMPACT_KEEP = 2
      WowTest.allEvents = {}
      for index = 1, 12 do
        local event = { k = "buy", itemId = 2589, qty = 1, cost = 100 * index }
        WowTest.ns.recordEvent(event)
        WowTest.allEvents[#WowTest.allEvents + 1] = event
      end
    `);
    expect(lua.number("WowTest.ns.Journal.book().checkpoint == nil and 0 or 1")).toBe(1);
    const same = lua.number(`(function()
      local full = WowTest.ns.Ledger.replay(WowTest.allEvents, "TestRealm|Alliance|Tester")
      local compact = WowTest.ns.Ledger.current()
      return full.positions[2589].qty == compact.positions[2589].qty
        and full.positions[2589].cost == compact.positions[2589].cost
        and full.capital.cashDelta == compact.capital.cashDelta and 1 or 0
    end)()`);
    expect(same).toBe(1);
    expect(lua.number("WowTest.ns.Journal.book().checkpoint.throughSeq")).toBeGreaterThan(0);
  });
});
