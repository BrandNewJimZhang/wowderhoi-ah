// The Forever scanner reads C_AuctionHouse.GetReplicateItemInfo instead of
// the legacy list API. These tests pin what pipeline v4 promises: the
// replicate fields land in the SavedVariables shape the terminal imports,
// the order book survives, demand (bid-only) is retained, and the inferred
// flow between two scans never counts a natural expiry as a sale.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

function auctionPage(): WowLua {
  const lua = loadAddon();
  lua.openTab(); // AUCTION_HOUSE_SHOW: the scanner refuses to run without it
  return lua;
}

function countItems(lua: WowLua): number {
  return lua.number(
    "(function() local n = 0 for _ in pairs(WoWderhoiAH_ScanData.items) do n = n + 1 end return n end)()"
  );
}

describe("forever replicate scan v4", () => {
  it("aggregates listings into the same scan shape the terminal imports", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 20000, quality: 1, vendorP: 100 },
      { itemId: 2589, name: "Linen Cloth", count: 20, buyout: 40000, quality: 1, vendorP: 100 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.dataVersion")).toBe(4);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].marketPrice")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].numAuctions")).toBe(2);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].vendorP")).toBe(100);
    expect(lua.number("WoWderhoiAH_ScanData.total")).toBe(2);
    const seriesSell = lua.number(
      "WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[2589].sell[1]"
    );
    expect(seriesSell).toBe(1000);
    // The series stores only the arrays its consumers read; P10, listing
    // count, seller count and inferred flow live on the scan snapshot and
    // are imported from there, not duplicated per history point.
    expect(lua.eval("WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[2589].p10")).toBeNull();
    expect(lua.number("WowTest.savedCount")).toBeGreaterThan(0);
  });

  it("records the free bag slots the scan was taken with", () => {
    // The terminal runs the same decision core but cannot read the bags.
    // Without this field it sized recommendations against a planning
    // constant; the scan must carry what the client actually reported.
    const lua = auctionPage();
    lua.exec("WowTest.freeBagSlots = { [0] = 2, [1] = 3, [2] = 1 }");
    lua.runScan([{ itemId: 2589, name: "Linen Cloth", count: 20, buyout: 20000 }]);
    expect(lua.number("WoWderhoiAH_ScanData.bagSlots")).toBe(6);
  });

  it("sums listings that share a unit price into one ladder rung", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 5, buyout: 1000 },
      { itemId: 2589, name: "Linen", count: 7, buyout: 1400 },
      { itemId: 2589, name: "Linen", count: 3, buyout: 1800 }
    ]);
    // The scan aggregates rungs as rows arrive; two books at 200/unit are
    // one rung of 12, not two entries the finish phase has to sort and merge.
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].p")).toBe(200);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].q")).toBe(12);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[2].p")).toBe(600);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[2].q")).toBe(3);
    expect(lua.number("#WoWderhoiAH_ScanData.items[2589].tiers")).toBe(2);
  });

  it("resolves item metadata once per session instead of once per scan", () => {
    const lua = auctionPage();
    const row = [{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }];
    lua.runScan(row);
    const afterFirst = lua.number("WowTest.itemInfoCalls or 0");
    lua.exec("WowTest.advance(900)");
    lua.runScan(row);
    const afterSecond = lua.number("WowTest.itemInfoCalls or 0");
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(afterFirst);
  });

  it("keeps the top of the price ladder so a multi-unit purchase can be priced", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 10000 },
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 20000 },
      { itemId: 2589, name: "Linen Cloth", count: 10, buyout: 30000 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].p")).toBe(1000);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[1].q")).toBe(10);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].tiers[3].p")).toBe(3000);
  });

  it("counts distinct sellers and falls back to listings when owners are hidden", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 1, buyout: 1000, owner: "Alice" },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1200, owner: "Bob" },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1400, owner: "Alice" }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].sellers")).toBe(2);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].sellersInvisible")).toBe(false);

    const hidden = auctionPage();
    hidden.runScan([
      { itemId: 2589, name: "Linen", count: 1, buyout: 1000, sellerUnknown: true },
      { itemId: 2589, name: "Linen", count: 1, buyout: 1200, sellerUnknown: true }
    ]);
    expect(hidden.number("WoWderhoiAH_ScanData.items[2589].sellers")).toBe(2);
    expect(hidden.eval("WoWderhoiAH_ScanData.items[2589].sellersInvisible")).toBe(true);
  });

  it("retains bid-only listings as a demand signal instead of dropping them", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 700, name: "Bid Only", count: 1, buyout: 0, bid: 500 },
      { itemId: 701, name: "Buyout", count: 1, buyout: 500 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[700].bidOnly")).toBe(1);
    expect(lua.number("WoWderhoiAH_ScanData.items[700].minPrice")).toBe(0);
    expect(lua.number("WoWderhoiAH_ScanData.items[700].highestBid")).toBe(500);
    expect(lua.number("WoWderhoiAH_ScanData.items[701].minPrice")).toBe(500);
    expect(lua.number("WoWderhoiAH_ScanData.items[701].highestBid")).toBe(0);
    // A zero-priced demand row must not enter the price series: its zeros
    // would drag the sell median and every chart toward zero.
    expect(lua.eval("WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[700] == nil")).toBe(true);
    expect(lua.number("WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[701].sell[1]")).toBe(500);
  });

  it("counts the core's history samples without materializing chart points", () => {
    const lua = auctionPage();
    const scan = (sell: number) => lua.runScan([
      { itemId: 2589, name: "Linen", count: 10, buyout: sell * 10 }
    ]);
    scan(1000);
    lua.exec("WowTest.advance(900)");
    scan(1050);
    // The radar asks for a count per item; the chart asks for points. Both
    // must agree on which retained points belong to the phase window, and
    // the scan stamps the same count for the next radar refresh to read.
    expect(lua.number("WowTest.ns.historySamples(2589)"))
      .toBe(lua.number("WowTest.ns.history(2589).samples"));
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].historySamples"))
      .toBe(lua.number("WowTest.ns.history(2589).samples"));
  });

  it("borrows the compiled steady window when the phase has none", () => {
    const lua = auctionPage();
    lua.runScan([{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("ignition");
    // Ignition's own window is 0; the trend/chart statistic reads the
    // steady window from the same compiled table instead of a literal.
    expect(lua.number("WowTest.ns.history(2589).windowHours"))
      .toBe(lua.number("WowTest.ns.RULES.phaseHistory.steady.windowHours"));
  });

  it("applies a phase override on the next call despite the phase cache", () => {
    const lua = auctionPage();
    lua.runScan([{ itemId: 2589, name: "Linen", count: 10, buyout: 10000 }]);
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("ignition");
    lua.exec("WowTest.ns.settings.phaseOverride = 'wave'");
    expect(lua.text("WowTest.ns.currentPhase()")).toBe("wave");
  });

  it("stores flow identity by owner and packs quantity and time left", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 10, buyout: 10000, owner: "Alice", timeLeft: 7200 }
    ]);
    // One double carries the pair: quantity * 2^20 + (timeLeft + 1), with 0
    // meaning "time left unknown". The packed value is what keeps 170k
    // listings from becoming 170k nested tables in SavedVariables.
    const packed = lua.number("WoWderhoiAH_Capture.items[2589].keys['Alice'][1000]");
    expect(Math.floor(packed / 1048576)).toBe(10);
    expect((packed % 1048576) - 1).toBe(7200);
  });

  it("ignores a capture written before the owner-keyed shape", () => {
    const lua = auctionPage();
    // The old shape keyed flow by the string "owner|unitPrice". Treating it
    // as owner -> price would iterate a number and error; the first scan
    // after the upgrade must start a fresh baseline.
    lua.exec(`WoWderhoiAH_Capture = {
      v = WowTest.ns.PIPELINE_VERSION,
      at = time(),
      market = GetRealmName() .. "|" .. UnitFactionGroup(),
      items = { [2589] = { keys = { ["Alice|1000"] = 100 }, t = { ["Alice|1000"] = 7200 }, total = 100 } }
    }`);
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 6300 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldHigh")).toBe(0);
  });

  it("infers disappeared quantity as an interval when the same tier shrinks", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 7200 }
    ]);
    lua.exec("WowTest.advance(900)");
    // 40 units vanished from the same price tier; the listing had two hours
    // left before the scan, so it cannot have expired in fifteen minutes.
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 6300 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldLow")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldHigh")).toBe(40);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].supplyGrowth")).toBe(0);
  });

  it("floors the flow window at one scan interval, not at one minute", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 7200 }
    ]);
    // A manual rescan a minute later is not a sale rate: the model must
    // read the compiled cadence, the same floor the terminal importer uses.
    lua.exec("WowTest.advance(60)");
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 7140 }
    ]);
    const floor = lua.number("WowTest.ns.RULES.scanIntervalMinutes") / 60;
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].elapsedHours")).toBeCloseTo(floor, 5);
  });

  it("separates a reprice from a sale in the interval", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 7200, owner: "Alice" }
    ]);
    lua.exec("WowTest.advance(900)");
    // The same 100 units moved from 100 to 120: the price key vanished, but
    // Alice's total did not, so the lower edge stays zero.
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 12000, timeLeft: 6300, owner: "Alice" }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldLow")).toBe(0);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldHigh")).toBe(100);
  });

  it("does not count a disappearance as a sale when the listing was about to expire", () => {
    const lua = auctionPage();
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 100, buyout: 10000, timeLeft: 120 }
    ]);
    lua.exec("WowTest.advance(900)");
    lua.runScan([
      { itemId: 2589, name: "Linen", count: 60, buyout: 6000, timeLeft: 60 }
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldLow")).toBe(0);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldHigh")).toBe(0);
  });

  it("folds an old hour to its close, not its open", () => {
    const lua = auctionPage();
    const series = "WoWderhoiAH_Series.markets['TestRealm|Alliance'].items[2589]";
    const scan = (sell: number) => lua.runScan([
      { itemId: 2589, name: "Linen", count: 10, buyout: sell * 10 }
    ]);
    // Three scans inside one hour; the moves stay under the 10% event
    // threshold so only the hourly close should survive the fold.
    scan(1000);
    lua.exec("WowTest.advance(900)");
    scan(1050);
    lua.exec("WowTest.advance(900)");
    scan(1080);
    // 25 hours later the three points are in the 24h–7d bucket; the fresh
    // scan is inside the full-resolution window.
    lua.exec("WowTest.advance(25 * 3600)");
    scan(1090);
    expect(lua.number(`#${series}.t`)).toBe(2);
    expect(lua.number(`${series}.sell[1]`)).toBe(1080);
    expect(lua.number(`${series}.sell[2]`)).toBe(1090);
  });

  it("does not skip a row when the per-frame budget boundary falls mid-book", () => {
    const lua = auctionPage();
    // PROCESS_PER_FRAME is the safety cap and the stub clock never trips the
    // time budget, so 2500 rows span three OnUpdate calls. The old cursor
    // advanced after the budget check and dropped the row at exactly this
    // boundary.
    const items = Array.from({ length: 2500 }, (_, index) => ({
      itemId: 10000 + index,
      name: `Item ${index}`,
      count: 1,
      buyout: 100 + index
    }));
    lua.runScan(items);
    expect(countItems(lua)).toBe(2500);
  });

  it("does not consume a stale replicate count from an item search", () => {
    const lua = auctionPage();
    // The client still holds the previous replicate response. An item
    // search firing while the new response is in flight must not make the
    // scanner process that stale book.
    lua.exec("WowTest.ah.replicate = { { itemId = 1, name = 'Old', count = 1, buyout = 100 } }");
    lua.exec("WowTest.ns.startScan()");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_NEW_RESULTS_RECEIVED', { itemID = 2589, itemLevel = 0, itemSuffix = 0, battlePetSpeciesID = 0 })");
    expect(lua.eval("WowTest.ns.scanRunning")).toBe(true);
    expect(lua.eval("WoWderhoiAH_ScanData == nil")).toBe(true);
  });

  it("aborts loudly when the client never answers a replicate request", () => {
    const lua = auctionPage();
    lua.exec("WowTest.ns.startScan()");
    lua.exec("WowTest.runTimers()");
    expect(lua.lastChat()).toContain("超时");
  });
});
