// The client broadcasts every auction action, not just the addon's own.
// These tests drive the native-UI events and assert that the journal books
// them exactly once.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

const LINEN = 2589;

function auction(lua: ReturnType<typeof loadAddon>, id: number, itemId: number, quantity: number, total: number) {
  lua.exec(`WowTest.ah.auctions[${id}] = {
    auctionID = ${id},
    itemKey = { itemID = ${itemId} },
    quantity = ${quantity},
    buyoutAmount = ${total},
    bidAmount = ${total}
  }`);
  lua.exec(`WowTest.setOwned({ { auctionID = ${id}, itemId = ${itemId}, quantity = ${quantity}, buyoutAmount = ${total} } })`);
}

function count(lua: ReturnType<typeof loadAddon>, kind: string) {
  return lua.number(`(function()
    local n = 0
    for _, event in ipairs(WowTest.ns.Journal.current()) do
      if event.k == "${kind}" then n = n + 1 end
    end
    return n
  end)()`);
}

describe("native auction actions", () => {
  it("books a posting created outside the addon", () => {
    const lua = loadAddon();
    auction(lua, 900, LINEN, 5, 5000);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTION_CREATED', 900)");
    expect(count(lua, "post")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('post').itemId")).toBe(LINEN);
    expect(lua.number("WowTest.ns.Journal.last('post').qty")).toBe(5);
    expect(lua.number("WowTest.ns.Journal.last('post').price")).toBe(1000);
    // The same event from the sell page's own handler must not book twice.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTION_CREATED', 900)");
    expect(count(lua, "post")).toBe(1);
  });

  it("books a cancellation and refunds the posting", () => {
    const lua = loadAddon();
    auction(lua, 901, LINEN, 4, 4000);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTION_CREATED', 901)");
    lua.exec("WowTest.fireEvent('AUCTION_CANCELED', 901)");
    expect(count(lua, "cancel")).toBe(1);
    expect(lua.number("(WowTest.ns.Ledger.positions()[2589] or {}).qty or 0")).toBe(0);
  });

  it("books an expiry without inventing a sale", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.recordEvent({ k = 'buy', itemId = 2589, qty = 4, cost = 4000 })");
    lua.exec("WowTest.ns.recordEvent({ k = 'post', auctionID = 902, itemId = 2589, qty = 4, price = 1000, deposit = 100 })");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTIONS_EXPIRED', 902)");
    expect(count(lua, "expire")).toBe(1);
    expect(count(lua, "sold")).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(100);
  });

  it("books a native item-auction purchase from the completion event", () => {
    const lua = loadAddon();
    auction(lua, 903, LINEN, 5, 5000);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED', 903)");
    expect(count(lua, "buy")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('buy').qty")).toBe(5);
    expect(lua.number("WowTest.ns.Journal.last('buy').cost")).toBe(5000);
  });

  it("books a native commodity fill with an estimated price", () => {
    const lua = loadAddon();
    lua.exec("WowTest.pendingCommodityResults[2589] = { { unitPrice = 100, quantity = 10 } }");
    lua.exec("WowTest.ah.commodityResults[2589] = { { unitPrice = 100, quantity = 10 } }");
    lua.exec("WowTest.ah.itemKeys[2589] = { itemID = 2589, isCommodity = true }");
    lua.exec("WowTest.fireEvent('COMMODITY_PURCHASED', 2589, 7)");
    expect(count(lua, "buy")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('buy').qty")).toBe(7);
    expect(lua.text("WowTest.ns.Journal.last('buy').priceSource")).toBe("estimated");
  });

  it("upgrades a native posting with the UI's exact deposit", () => {
    const lua = loadAddon();
    auction(lua, 905, LINEN, 5, 5000);
    // The event fires first and books the posting without a deposit.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_AUCTION_CREATED', 905)");
    const before = lua.number("WowTest.ns.Journal.revision()");
    lua.exec(`WowTest.ns.Actions.post(905, {
      itemId = ${LINEN}, qty = 5, price = 1000, deposit = 100
    })`);
    expect(count(lua, "post")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('post').deposit")).toBe(100);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(100);
    // An in-place correction must move the revision the watcher compares;
    // otherwise the corrected cost never leaves the machine.
    expect(lua.number("WowTest.ns.Journal.revision()")).toBe(before + 1);
  });

  it("upgrades a native purchase with the UI's exact cost", () => {
    const lua = loadAddon();
    auction(lua, 906, LINEN, 5, 5000);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_PURCHASE_COMPLETED', 906)");
    lua.exec(`WowTest.ns.Actions.purchase(906, {
      itemId = ${LINEN}, qty = 5, cost = 4000
    })`);
    expect(count(lua, "buy")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('buy').cost")).toBe(4000);
    expect(lua.number("WowTest.ns.Ledger.capital().cashDelta")).toBe(-4000);
  });

  it("records a bid as an annotation, not a cash movement", () => {
    const lua = loadAddon();
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_NEW_BID_RECEIVED', 904, 1200)");
    expect(count(lua, "bid")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.capital().cashDelta")).toBe(0);
  });

  it("does not mistake a bid id for an auction id", () => {
    const lua = loadAddon();
    // BID_ADDED carries the bid id; BIDS_UPDATED carries nothing. Neither
    // can name the auction a journal fact is deduplicated by.
    lua.exec("WowTest.fireEvent('BID_ADDED', 55)");
    lua.exec("WowTest.fireEvent('BIDS_UPDATED')");
    expect(count(lua, "bid")).toBe(0);
  });
});
