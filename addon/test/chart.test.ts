// The chart's first job is the order book: with fewer than two scans the
// time series has nothing honest to draw. Once history exists it switches
// to a windowed trend with a sell-front line, a minimum line, supply bars,
// data-gap breaks and a log axis when the range is wide.

import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function chartPage(closes?: number[], tiers?: Array<{ p: number; q: number }>): WowLua {
  const lua = loadAddon();
  lua.setScan([{
    itemId: 4338,
    name: "Mageweave Cloth",
    minPrice: 8000,
    sellP: 10000,
    numAuctions: 6,
    sellers: 3,
    quantity: 70,
    itemClass: "Trade Goods",
    tiers: tiers ?? [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
  }]);
  if (closes) lua.setPoints([{ itemId: 4338, closes }]);
  lua.openTab();
  lua.exec("WoWderhoiAH_UpdateChart(4338)");
  return lua;
}

describe("order-book chart", () => {
  it("is the default when there is no history to plot", () => {
    const lua = chartPage();
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("book");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(2);
    expect(lua.number("WowTest.ns.chartState().supply")).toBe(70);
    expect(lua.number("WowTest.ns.chartState().sellP")).toBe(10000);
  });

  it("draws a staircase, not a single point", () => {
    const lua = chartPage();
    // Two tiers produce two vertical segments and one tread.
    expect(lua.number("#WoWderhoiAHChart.segments")).toBeGreaterThanOrEqual(3);
  });

  it("says the scan has no book instead of drawing an empty box", () => {
    const lua = loadAddon();
    lua.setScan([{
      itemId: 4338, name: "No Book", minPrice: 8000, sellP: 8000,
      numAuctions: 1, sellers: 1, quantity: 1, itemClass: "Trade Goods", tiers: []
    }]);
    lua.openTab();
    lua.exec("WoWderhoiAH_UpdateChart(4338)");
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("book");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(0);
    expect(lua.text("WoWderhoiAHChart.hilo:GetText()")).toBe("本次扫描没有盘口数据");
  });
});

describe("time-series chart", () => {
  it("switches to the trend once two scans exist", () => {
    const lua = chartPage([9000, 10000, 11000]);
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("time");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(3);
    expect(lua.number("WowTest.ns.chartState().segments")).toBeGreaterThan(0);
  });

  it("keeps a state record when every point has no price", () => {
    // A scan can record a series point without a sell front. The empty
    // state still has to name its mode and point count: the renderer writes
    // the item into that record after drawing.
    const lua = chartPage([0, 0]);
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("time");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(2);
    expect(lua.text("WoWderhoiAHChart.hilo:GetText()")).toBe("该时间窗内扫描次数不足");
  });

  it("filters to the selected window and falls back to the empty state", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WowTest.ns.setChartWindow(1)");
    expect(lua.number("WowTest.ns.chartState().window")).toBe(1);
    // All fixture points sit within 30 minutes, so a one-hour window keeps
    // them; an impossible window would keep none and say so.
    expect(lua.number("WowTest.ns.chartState().points")).toBe(3);
    lua.exec("WowTest.ns.setChartWindow(0.0001)");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(1);
    expect(lua.text("WoWderhoiAHChart.hilo:GetText()")).toBe("该时间窗内扫描次数不足");
  });

  it("keeps points older than the phase default when a wider window is selected", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.settings.phaseOverride = 'wave'");
    lua.setScan([{
      itemId: 4338,
      name: "Mageweave Cloth",
      minPrice: 8000,
      sellP: 10000,
      numAuctions: 6,
      sellers: 3,
      quantity: 70,
      itemClass: "Trade Goods",
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
    }]);
    // One point now, one 12 hours ago, one 25 hours ago. The wave default
    // is a six-hour window, so the selected window — not the phase window —
    // must reach the older points.
    lua.exec(`WoWderhoiAH_Series = ${toLua({
      v: 4,
      markets: {
        "TestRealm|Alliance": {
          firstScanAt: 1699913600,
          items: {
            4338: {
              t: [1699910000, 1699956800, 1700000000],
              min: [8000, 8000, 8000],
              sell: [9000, 9500, 10000],
              q: [60, 65, 70],
              e: [0, 0, 0]
            }
          }
        }
      }
    })}`);
    lua.openTab();
    lua.exec("WoWderhoiAH_UpdateChart(4338)");
    // The series spans a day, so the chart stays in time mode; the phase
    // default only decides how much of it is drawn.
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("time");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(1);
    lua.exec("WowTest.ns.setChartWindow(24)");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(2);
    lua.exec("WowTest.ns.setChartWindow(168)");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(3);
  });

  it("switches to a log axis when the range spans more than 4x", () => {
    const lua = chartPage([100, 1000, 5000]);
    expect(lua.eval("WowTest.ns.chartState().logScale")).toBe(true);
  });

  it("keeps a linear axis for a normal range", () => {
    const lua = chartPage([9000, 10000, 11000]);
    expect(lua.eval("WowTest.ns.chartState().logScale")).toBe(false);
  });

  it("breaks the line across a long scanning gap instead of inventing data", () => {
    const lua = loadAddon();
    lua.setScan([{
      itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
      numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
    }]);
    lua.exec(`WoWderhoiAH_Series = ${toLua({
      v: 4,
      markets: {
        "TestRealm|Alliance": {
          firstScanAt: 1699990000,
          items: {
            4338: {
              t: [1699990000, 1699990900, 1699999800, 1700000000],
              min: [8000, 8000, 8000, 8000],
              sell: [10000, 10100, 10200, 10300],
              q: [60, 61, 62, 63],
              e: [0, 0, 0, 0]
            }
          }
        }
      }
    })}`);
    lua.openTab();
    lua.exec("WoWderhoiAH_UpdateChart(4338)");
    // Four points, but the third gap is ~2.5 hours against a 15-minute
    // cadence: that segment is dropped rather than bridging the hole.
    expect(lua.number("WowTest.ns.chartState().points")).toBe(4);
    expect(lua.number("WowTest.ns.chartState().segments")).toBeLessThan(6);
  });
});

describe("chart consumer", () => {
  // A hover with no scan or history must clear the panel, not leave the
  // previous item's picture standing under the new item's tooltip.
  it("hides on a no-data hover and returns on the next item", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec(`GameTooltip:SetHyperlink("item:9999:0:0:0")`);
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
    lua.exec(`GameTooltip:SetHyperlink("item:4338:0:0:0")`);
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    expect(lua.number("WowTest.ns.chartState().itemId")).toBe(4338);
  });

  // The buttons share the one refresh entry. With the chart switched off
  // they must not paint the panel back into existence.
  it("keeps the window buttons inert while the chart is switched off", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WowTest.ns.settings.chart = false; WowTest.ns.setChartWindow(6)");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
    lua.exec("WowTest.ns.setChartMode('book')");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
  });

  it("returns as soon as the chart switch is on again", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WowTest.ns.settings.chart = false; WoWderhoiAH_UpdateChart()");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
    lua.exec("WowTest.ns.settings.chart = true; WoWderhoiAH_UpdateChart()");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
  });

  it("updates the chart on hover while the tooltip block is off", () => {
    const lua = loadAddon();
    lua.setScan([{
      itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
      numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
    }]);
    lua.setPoints([{ itemId: 4338, closes: [9000, 10000, 11000] }]);
    lua.openTab();
    lua.exec(`
      WowTest.ns.settings.tooltip = false
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    expect(lua.number("WowTest.ns.chartState().itemId")).toBe(4338);
  });
});

describe("chart lifecycle", () => {
  // A finished scan publishes a new book and a new series point. The panel
  // is already on screen; it must redraw from that event, not wait for the
  // player to hover the item again.
  it("refreshes on a finished scan without another hover", () => {
    const lua = chartPage();
    expect(lua.number("WowTest.ns.chartState().supply")).toBe(70);
    lua.runScan([{ itemId: 4338, name: "Mageweave Cloth", count: 5, buyout: 5000, quality: 1 }]);
    expect(lua.number("WowTest.ns.chartState().supply")).toBe(5);
  });

  // The trader page is created inside the same AUCTION_HOUSE_SHOW dispatch,
  // after this file's handler. The page registers itself when created, so
  // the chart ends up beside the page rather than staying on the AH frame.
  it("docks to the trader page when that page is created later", () => {
    const lua = loadAddon();
    lua.setScan([{
      itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
      numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
    }]);
    lua.setPoints([{ itemId: 4338, closes: [9000, 10000, 11000] }]);
    lua.exec(`
      WowTest.fireEvent("AUCTION_HOUSE_CLOSED")
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.eval("WoWderhoiAHChart == nil or not WoWderhoiAHChart:IsShown()")).toBe(true);
    lua.openTab();
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    expect(lua.eval("WoWderhoiAHChart._points.TOPLEFT.to == WoWderhoiAHTrade")).toBe(true);
  });

  // The checkbox writes the setting and notifies the consumer in the same
  // click; no /reload and no extra hover.
  it("applies a settings toggle without waiting for a hover", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.showSettings();
    lua.exec("WoWderhoiAHOption3:SetChecked(false)");
    lua.clickSetting("chart");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
    lua.exec("WoWderhoiAHOption3:SetChecked(true)");
    lua.clickSetting("chart");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
  });
});

describe("phase window and retention", () => {
  // The default window is the compiled rule the tooltip and the decision
  // core already read. Ignition has no window of its own and borrows
  // steady's, exactly as the data layer does.
  it("sources the default window from the compiled phase rules", () => {
    const lua = chartPage([9000, 10000, 11000]);
    expect(lua.number("WowTest.ns.phaseWindowHours()")).toBe(168);
    expect(lua.number("WowTest.ns.chartState().window")).toBe(168);
    const expected: Array<[string, number]> = [
      ["ignition", 168], ["wave", 6], ["settle", 24], ["steady", 168]
    ];
    for (const [phase, hours] of expected) {
      lua.exec(`WowTest.ns.settings.phaseOverride = '${phase}'; WoWderhoiAH_UpdateChart()`);
      expect(lua.number("WowTest.ns.phaseWindowHours()")).toBe(hours);
      expect(lua.number("WowTest.ns.chartState().window")).toBe(hours);
    }
  });

  it("sources the all-window span from the series retention", () => {
    const lua = chartPage([9000, 10000, 11000]);
    expect(lua.number("WowTest.ns.seriesRetentionHours()")).toBe(720);
    lua.exec("WowTest.ns.setChartWindow(0)");
    expect(lua.number("WowTest.ns.chartState().points")).toBe(3);
  });
});

describe("chart placement", () => {
  // The chart is a panel, not a tooltip ornament. It docks beside the
  // auction house or the trader page and stays there, so its mode/window
  // buttons never race the tooltip's hide. With neither panel open it has
  // no home and must not appear next to a bag item's tooltip.

  it("stays beside the trader page after the tooltip closes", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("GameTooltip:Show()");
    lua.exec("GameTooltip:Hide()");
    expect(lua.text("WowTest.ns.chartState().mode")).toBe("time");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    // A window button in the persistent panel still works after the
    // tooltip is gone, which is the whole point of docking it.
    lua.exec("WowTest.clickButton('6时')");
    expect(lua.number("WowTest.ns.chartState().window")).toBe(6);
  });

  it("moves to the auction house when the trader page closes", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WoWderhoiAHTrade:Hide()");
    expect(lua.eval("WoWderhoiAHChart._points.TOPLEFT.to == AuctionHouseFrame")).toBe(true);
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    lua.exec("WowTest.clickButton('6时')");
    expect(lua.number("WowTest.ns.chartState().window")).toBe(6);
  });

  // The trader page is movable. A page dragged to the right edge must not
  // push the chart's title, scale or buttons off screen.
  it("docks to the left when the anchor has no room on its right", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec(`
      UIParent.GetWidth = function() return 1024 end
      AuctionHouseFrame.GetRight = function() return 900 end
      WoWderhoiAHTrade:Hide()
    `);
    expect(lua.eval("WoWderhoiAHChart._points.TOPRIGHT.to == AuctionHouseFrame")).toBe(true);
  });

  it("clamps the chart panel to the screen", () => {
    const lua = chartPage([9000, 10000, 11000]);
    expect(lua.eval("WoWderhoiAHChart._clamped")).toBe(true);
  });

  it("hides when the last panel closes", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
  });

  it("does not float beside a bag item tooltip", () => {
    const lua = chartPage([9000, 10000, 11000]);
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    // The tooltip still carries the price block; the chart does not follow.
    expect(lua.tooltipText()).toContain("最低价");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
  });
});
