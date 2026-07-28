// The deal radar exists twice -- addon/WoWderhoiAH/Trade.lua for the buy
// button and src/lib/analytics.ts for the web view -- and they must classify
// the same scan identically, or the terminal promises deals the in-game list
// cannot deliver. These tests run one fixture through both.
//
// They also pin the two credibility gates that a thin realm makes necessary:
// a flat P10 series is one camper's ask repeated, and a discount past the cap
// means the reference broke rather than the listing being cheap.

import { describe, expect, it } from "vitest";
import { buildDealRadar, buildMarketSignal } from "@/lib/analytics";
import { dealRadarRules } from "@/lib/market-rules";
import { loadAddon, type WowLua } from "./wow-lua";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-24T12:00:00Z");
const VENDOR_TAG = " [NPC必赚]";

type Candidate = {
  itemId: number;
  name: string;
  minPrice: number;
  numAuctions: number;
  vendorPrice?: number;
  closes: number[]; // the P10 series, oldest first, one entry per scan
};

// The control every gate test is measured against: 3 scans, a moving
// reference, a live book, and a min price 27% under med7 = 11000.
const CLEAN: Candidate = {
  itemId: 4338, name: "Clean Discount", minPrice: 8000, numAuctions: 6, closes: [10000, 11000, 12000]
};

function radar(candidates: Candidate[]): WowLua {
  const lua = loadAddon();
  lua.setScan(candidates.map((candidate) => ({
    itemId: candidate.itemId,
    name: candidate.name,
    minPrice: candidate.minPrice,
    vendorP: candidate.vendorPrice ?? 0,
    numAuctions: candidate.numAuctions
  })));
  lua.setPoints(candidates.map(({ itemId, closes }) => ({ itemId, closes })));
  lua.openTab();
  return lua;
}

// The addon has no readable deal model -- rows exist only as rendered text --
// so read the class back off the name tag the player actually sees, and the
// discount off the column, which is where med7 becomes visible.
function classifiedByAddon(lua: WowLua) {
  const discounts = lua.column(1);
  return lua.names().map((rendered, index) => ({
    name: rendered.replace(VENDOR_TAG, ""),
    vendor: rendered.endsWith(VENDOR_TAG),
    discountPercent: Number(discounts[index].replace(/[-%]/g, ""))
  }));
}

function classifiedByWeb(candidates: Candidate[]) {
  const signals = candidates.map((candidate) => {
    const last = candidate.closes.length - 1;
    return buildMarketSignal({
      itemId: candidate.itemId,
      name: candidate.name,
      quality: "common",
      category: "矿石",
      subCategory: "采矿",
      vendorPrice: candidate.vendorPrice ?? 0,
      snapshots: candidate.closes.map((price, index) => ({
        timestamp: new Date(NOW.getTime() - (last - index) * DAY),
        server: "TestRealm",
        faction: "Alliance",
        marketPrice: price,
        minPrice: index === last ? candidate.minPrice : price,
        quantity: 100,
        numAuctions: index === last ? candidate.numAuctions : 10
      })),
      dailySummaries: []
    }, NOW);
  });
  return buildDealRadar(signals).map((row) => ({
    name: row.name,
    vendor: row.vendor,
    discountPercent: row.discountPercent
  }));
}

// Every gate case is shaped to fail exactly one condition, so a passing test
// names the gate that rejected it rather than "something rejected it".
const REJECTED: Array<{ why: string; candidate: Candidate }> = [
  {
    why: "a flat P10 series is one camper's ask, not a market",
    candidate: { itemId: 1, name: "Flat Series", minPrice: 30000, numAuctions: 6, closes: [50000, 50000, 50000] }
  },
  {
    why: "a discount past the cap means the reference broke",
    candidate: { itemId: 2, name: "Collapsed Reference", minPrice: 3000, numAuctions: 6, closes: [10000, 11000, 12000] }
  },
  {
    why: "a two-listing book cannot support a median",
    candidate: { itemId: 3, name: "Thin Book", minPrice: 8000, numAuctions: 2, closes: [10000, 11000, 12000] }
  },
  {
    why: "two scans are not enough history",
    candidate: { itemId: 4, name: "Short History", minPrice: 8000, numAuctions: 6, closes: [10000, 11000] }
  },
  {
    why: "a 3s spread is not worth a trip",
    candidate: { itemId: 5, name: "Penny Spread", minPrice: 800, numAuctions: 6, closes: [1000, 1100, 1200] }
  },
  {
    why: "14% under is not a deal",
    candidate: { itemId: 6, name: "Barely Cheap", minPrice: 9400, numAuctions: 6, closes: [10000, 11000, 12000] }
  },
  {
    why: "no history at all",
    candidate: { itemId: 7, name: "Never Scanned", minPrice: 8000, numAuctions: 6, closes: [] }
  }
];

describe("deal radar gates", () => {
  it("lists a discount backed by a moving reference and a live book", () => {
    expect(radar([CLEAN]).names()).toEqual(["Clean Discount"]);
  });

  it.each(REJECTED)("rejects it when $why", ({ candidate }) => {
    // The control rides along so a green test proves the gate rejected the
    // candidate, not that the whole fixture failed to produce any deal.
    expect(radar([CLEAN, candidate]).names()).toEqual(["Clean Discount"]);
  });

  it("exempts vendor arbitrage from both credibility gates", () => {
    // Flat series and 70% under the reference: rejected outright as a median
    // discount, but the NPC sell price is a fact, not an estimate.
    const vendor: Candidate = {
      itemId: 2589, name: "Vendor Flat", minPrice: 300, numAuctions: 1, vendorPrice: 1000, closes: [700, 700, 700]
    };
    expect(radar([vendor]).names()).toEqual([`Vendor Flat${VENDOR_TAG}`]);
  });
});

describe("history statistics", () => {
  it("counts distinct closes, which is what tells a market from a camper", () => {
    const lua = loadAddon();
    lua.setPoints([
      { itemId: 1, closes: [500, 500, 500] },
      { itemId: 2, closes: [500, 700, 500] }
    ]);
    expect(lua.number("WowTest.ns.history(1).distinct")).toBe(1);
    expect(lua.number("WowTest.ns.history(2).distinct")).toBe(2);
    // Lower median of [500, 500, 700], matching src/lib/analytics.ts median().
    expect(lua.number("WowTest.ns.history(2).med7")).toBe(500);
    expect(lua.eval("WowTest.ns.history(999)")).toBeNull();
  });

  it("loads the generated thresholds the web rules generated", () => {
    const lua = loadAddon();
    for (const [rule, value] of Object.entries(dealRadarRules)) {
      expect(lua.number(`WowTest.ns.RADAR.${rule}`)).toBe(value);
    }
  });
});

describe("addon and web classify a scan identically", () => {
  const SCAN: Candidate[] = [
    CLEAN,
    { itemId: 2589, name: "Vendor Flat", minPrice: 300, numAuctions: 1, vendorPrice: 1000, closes: [700, 700, 700] },
    ...REJECTED.filter(({ candidate }) => candidate.closes.length > 0).map(({ candidate }) => candidate)
  ];

  it("agrees on which listings are deals, in which order, and of which class", () => {
    const addon = classifiedByAddon(radar(SCAN));
    const web = classifiedByWeb(SCAN);
    // Vendor first because it is risk-free, then by absolute profit.
    const expected = [{ name: "Vendor Flat", vendor: true }, { name: "Clean Discount", vendor: false }];
    expect(addon.map(({ name, vendor }) => ({ name, vendor }))).toEqual(expected);
    expect(web.map(({ name, vendor }) => ({ name, vendor }))).toEqual(expected);
    // The discount is where the reference price becomes visible, so agreeing
    // on it is agreeing on med7 itself -- membership alone would survive the
    // two median implementations drifting apart. The addon rounds to whole
    // percent for display, which is the only slack allowed here.
    addon.forEach((row, index) => {
      expect(row.discountPercent).toBeCloseTo(web[index].discountPercent, 0);
    });
  });
});
