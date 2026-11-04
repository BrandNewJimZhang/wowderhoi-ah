// The WAH page can stay open after the auction house closes, and the radar
// still renders from the last scan. A search has no server to talk to in
// that state: querying anyway would either error or, worse, fill the book
// with whatever stale browse results the client still had.

import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

describe("auction house state", () => {
  it("refuses to search once the auction house has closed", () => {
    const lua = loadAddon();
    lua.openTab();
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    lua.exec("WowTest.ns.openTrade()");
    lua.search("Linen", [{ itemId: 2589, name: "Linen Cloth", count: 1, buyout: 100 }]);
    expect(lua.lastChat()).toContain("请先打开拍卖行");
  });

  it("opens the page with the auction house by default", () => {
    const lua = loadAddon();
    lua.openTab();
    expect(lua.eval("WowTest.ns.tradeFrame():IsShown()")).toBe(true);
  });
});
