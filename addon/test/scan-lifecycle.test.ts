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
    expect(lua.number("WowTest.lastStats().cursor")).toBe(1);
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
    expect(lua.number("WowTest.lastStats().cursor")).toBe(3000);
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
