// The scan lifecycle is an explicit state machine. These tests drive it
// through the outcomes the old wall-clock guard could not distinguish:
// a dedicated response, a browse failure, a closed auction house, a copy
// cleared mid-read and an empty answer. Every exit must leave stats behind.

import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function page(): WowLua {
  const lua = loadAddon();
  lua.openTab(); // AUCTION_HOUSE_SHOW: the scanner refuses to run without it
  return lua;
}

function setRows(lua: WowLua, items: unknown[]): void {
  lua.exec(`WowTest.ah.replicate = ${toLua(items)}`);
}

function drive(lua: WowLua, frames = 1000): void {
  for (let index = 0; index < frames; index += 1) {
    if (!lua.eval("WowTest.ns.scanRunning")) return;
    lua.exec("WowTest.tickFrames(1)");
  }
  throw new Error("scan did not finish");
}

function requestScan(lua: WowLua): void {
  lua.exec("WowTest.ns.startScan()");
  expect(lua.eval("WowTest.ns.scanRunning")).toBe(true);
}

describe("scan lifecycle", () => {
  it("accepts the dedicated replicate event as the acknowledgement", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    drive(lua);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.eval("WowTest.lastStats().reason")).toBeNull();
    expect(lua.text("WowTest.lastStats().responseVia")).toBe("replicate");
    expect(lua.number("WowTest.lastStats().rows")).toBe(1);
    expect(lua.number("WowTest.lastStats().total")).toBe(1);
  });

  it("aborts on an explicit browse failure", () => {
    const lua = page();
    requestScan(lua);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_BROWSE_FAILURE')");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.text("WowTest.lastStats().reason")).toBe("browse_failure");
    expect(lua.lastChat()).toContain("browse failure");
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("aborts a scan still waiting when the auction house closes", () => {
    const lua = page();
    requestScan(lua);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.text("WowTest.lastStats().reason")).toBe("ah_closed");
    expect(lua.lastChat()).toContain("拍卖行已关闭");
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("finishes a copy already received when the auction house closes", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    // One frame consumes the rows and starts the finish phase; the copy is
    // now entirely in this addon's tables.
    lua.exec("WowTest.tickFrames(1)");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    drive(lua);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.eval("WowTest.lastStats().reason")).toBeNull();
  });

  it("refuses to publish a copy that was cleared mid-read", () => {
    const lua = page();
    setRows(lua, [
      { itemId: 2589, name: "Linen", count: 10, buyout: 10000 },
      { itemId: 2590, name: "Wool", count: 10, buyout: 20000 }
    ]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    // The client drops the copy before the first frame reads it.
    lua.exec("WowTest.ah.replicate = {}");
    drive(lua);
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.text("WowTest.lastStats().reason")).toBe("replicate_cleared");
    expect(lua.number("WowTest.lastStats().badRows")).toBe(2);
    expect(lua.lastChat()).toContain("复制数据在读取过程中被清空");
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("reports an empty replicate answer instead of saving nothing", () => {
    const lua = page();
    setRows(lua, []);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.text("WowTest.lastStats().reason")).toBe("empty");
    expect(lua.lastChat()).toContain("空副本");
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("keeps waiting even when the answer takes almost three minutes", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    requestScan(lua);
    lua.advance(179);
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(true);
    lua.exec("WowTest.fireReplicate()");
    drive(lua);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
  });

  it("reports no response when the waiting watchdog expires", () => {
    const lua = page();
    requestScan(lua);
    lua.advance(180);
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.text("WowTest.lastStats().reason")).toBe("no_response");
    expect(lua.text("WowTest.lastStats().phase")).toBe("waiting");
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("finishes a slow row phase whose frames cross the watchdog window", () => {
    const lua = page();
    // Each client call costs 0.1 ms and each simulated frame spends six
    // wall-clock seconds; the book needs about 40 frames, i.e. four minutes.
    // That is slower than the waiting watchdog and must still complete.
    const items = Array.from({ length: 3000 }, (_, index) => ({
      itemId: 10000 + index,
      name: `Item ${index}`,
      count: 1,
      buyout: 100 + index
    }));
    lua.exec("WowTest.setFrameCost(0.1)");
    setRows(lua, items);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    for (let frame = 0; frame < 500 && lua.eval("WowTest.ns.scanRunning"); frame += 1) {
      lua.exec("WowTest.tickFrames(1, 6000)");
    }
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.number("WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.total or -1")).toBe(3000);
    expect(lua.number("WowTest.lastStats().rows")).toBe(3000);
    expect(lua.eval("WowTest.lastStats().reason")).toBeNull();
  });

  it("announces progress while the rows are processed", () => {
    const lua = page();
    setRows(lua, Array.from({ length: 3000 }, (_, index) => ({
      itemId: 10000 + index, name: `Item ${index}`, count: 1, buyout: 100 + index
    })));
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    drive(lua);
    expect(lua.anyChat("已处理 ")).toBe(true);
  });

  it("refuses a second manual request inside the one-minute floor", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    requestScan(lua);
    // Closing the house aborts the scan without setting a retry window.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    expect(lua.number("WowTest.ns.settings.lastReplicateAt")).toBeGreaterThan(0);
    expect(lua.eval("WowTest.ns.startScan()")).toBe(false);
    expect(lua.lastChat()).toContain("请再等");
    lua.advance(60);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_SHOW')");
    expect(lua.eval("WowTest.ns.startScan()")).toBe(true);
  });

  it("holds the retry window after a failed request", () => {
    const lua = page();
    requestScan(lua);
    lua.advance(180); // the waiting watchdog reports no answer at t+180
    expect(lua.text("WowTest.lastStats().reason")).toBe("no_response");
    expect(lua.number("WowTest.ns.settings.retryAfter")).toBe(1700000000 + 300);
    expect(lua.eval("WowTest.ns.startScan()")).toBe(false);
    expect(lua.lastChat()).toContain("上次请求失败");
    lua.advance(120);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_SHOW')");
    expect(lua.eval("WowTest.ns.startScan()")).toBe(true);
  });

  it("runs the automatic cadence on the compiled interval, not on reload state", () => {
    const lua = page();
    lua.exec("WowTest.ns.settings.autoScan = true");
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    expect(lua.eval("WowTest.ns.requestScan('auto')")).toBe(true);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_SHOW')");
    // The live ticker would start the scan itself while the clock advances;
    // disable it so the explicit admission calls are what is under test.
    lua.exec("WowTest.ns.settings.autoScan = false");
    lua.advance(899);
    lua.exec("WowTest.ns.settings.autoScan = true");
    expect(lua.eval("WowTest.ns.requestScan('auto')")).toBe(false);
    lua.exec("WowTest.ns.settings.autoScan = false");
    lua.advance(1);
    lua.exec("WowTest.ns.settings.autoScan = true");
    expect(lua.eval("WowTest.ns.requestScan('auto')")).toBe(true);
  });

  it("keeps a row whose item record has not loaded and fills it when it does", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "", count: 10, buyout: 10000, hasAllInfo: false }]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    lua.exec("WowTest.tickFrames(1)");
    // The observation is complete; the scan is only waiting to improve the
    // metadata attached to it.
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(true);
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
    lua.exec(`WowTest.itemInfo[2589] = {
      name = "Linen Cloth", class = "Trade Goods", subClass = "Cloth", quality = 1, vendorP = 100
    }`);
    lua.exec("WowTest.sendItemDataLoaded(2589)");
    drive(lua);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].name")).toBe("Linen Cloth");
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    // The name was resolved before the book was published, so nothing is
    // missing at the moment the stats are stamped.
    expect(lua.number("WowTest.lastStats().itemsMissingInfo")).toBe(0);
  });

  it("fills a name when the item record loads before the rows finish", () => {
    const lua = page();
    // 1,500 rows span two frames at 1,000 rows per frame, so the load result
    // arrives while the phase is still "rows". Ignoring the event there used
    // to leave an already-loaded name empty for the rest of the scan.
    setRows(lua, Array.from({ length: 1500 }, (_, index) => ({
      itemId: 10000 + index, name: "", count: 1, buyout: 100 + index, hasAllInfo: false
    })));
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    lua.exec("WowTest.tickFrames(1)");
    lua.exec(`WowTest.itemInfo[10000] = {
      name = "Late Cloth", class = "Trade Goods", subClass = "Cloth", quality = 1, vendorP = 5
    }`);
    lua.exec("WowTest.sendItemDataLoaded(10000)");
    lua.exec("WowTest.tickFrames(1)");
    lua.advance(3); // the other 1,499 names never arrive
    drive(lua);
    expect(lua.text("WoWderhoiAH_ScanData.items[10000].name")).toBe("Late Cloth");
    expect(lua.number("WowTest.lastStats().rows")).toBe(1500);
  });

  it("publishes an unresolved name after the bounded hydrate window", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "", count: 10, buyout: 10000, hasAllInfo: false }]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    lua.exec("WowTest.tickFrames(1)");
    lua.advance(3); // the item record never arrives
    drive(lua);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].name")).toBe("");
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.number("WowTest.lastStats().itemsMissingInfo")).toBe(1);
  });

  it("uses the name a partially loaded row did carry", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000, hasAllInfo: false }]);
    requestScan(lua);
    lua.exec("WowTest.fireReplicate()");
    drive(lua);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].name")).toBe("Linen");
    expect(lua.number("WowTest.lastStats().itemsMissingInfo")).toBe(0);
  });

  it("ignores a response that arrives after the scan was aborted", () => {
    const lua = page();
    setRows(lua, [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    requestScan(lua);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_BROWSE_FAILURE')");
    lua.exec("WowTest.fireReplicate()");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(false);
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });
});
