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

describe("chart lifetime", () => {
  // The chart sits beside an item tooltip, so hiding the tooltip used to
  // hide the chart -- and its mode/window buttons -- before the pointer
  // could reach them. These drive the pointer path the player takes.
  function detached(): WowLua {
    const lua = chartPage([9000, 10000, 11000]);
    // Outside the auction house the chart is anchored to the tooltip, so
    // closing the house arms the hide path under test.
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_CLOSED')");
    lua.exec("WoWderhoiAH_UpdateChart(4338)");
    lua.exec("GameTooltip:Show()");
    return lua;
  }

  it("outlives the tooltip long enough to click a window button", () => {
    const lua = detached();
    lua.exec("GameTooltip:Hide()");
    // Not hidden synchronously: the pointer may still be crossing the gap.
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    lua.exec("WowTest.runTimers()");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
  });

  it("stays while the pointer is on it and a click re-renders it", () => {
    const lua = detached();
    lua.exec("GameTooltip:Hide()");
    lua.exec("WoWderhoiAHChart._scripts.OnEnter(WoWderhoiAHChart)");
    lua.exec("WowTest.runTimers()");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("true");
    // The window button the pointer just reached keeps working.
    lua.exec("WowTest.ns.setChartWindow(6)");
    expect(lua.number("WowTest.ns.chartState().window")).toBe(6);
    lua.exec("WoWderhoiAHChart._scripts.OnLeave(WoWderhoiAHChart)");
    lua.exec("WowTest.runTimers()");
    expect(lua.text("WoWderhoiAHChart:IsShown()")).toBe("false");
  });
});
