// The radar is no longer a P10 discount list. It is Core.lua's evaluation
// of what can be bought and resold under the current phase's gates, and
// these tests pin the contract that replaced the old median rules:
// executable quantity, ladder cost, sell front, net profit and fill
// probability -- with vendor arbitrage always first.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

type Candidate = {
  itemId: number;
  name: string;
  minPrice: number;
  sellP?: number;
  vendorP?: number;
  numAuctions: number;
  sellers?: number;
  quantity?: number;
  tiers?: Array<{ p: number; q: number }>;
  closes?: number[];
};

const CLEAN: Candidate = {
  itemId: 4338, name: "Clean Spread", minPrice: 8000, sellP: 10000,
  numAuctions: 6, sellers: 3, quantity: 70,
  tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }],
  // Six scans, so the wave phase's history floor is met without changing
  // the lower median (11000) that anchors the spread.
  closes: [10000, 10500, 11000, 11500, 11000, 11000]
};

const VENDOR: Candidate = {
  itemId: 2589, name: "Vendor Flat", minPrice: 300, vendorP: 1000,
  numAuctions: 1, sellers: 1, quantity: 10, tiers: [{ p: 300, q: 10 }],
  closes: [700, 700, 700]
};

function radar(candidates: Candidate[], phase?: string): WowLua {
  const lua = loadAddon();
  if (phase) lua.exec(`WoWderhoiAH_Settings.phaseOverride = ${JSON.stringify(phase)}`);
  lua.setScan(candidates.map((candidate) => ({
    itemId: candidate.itemId,
    name: candidate.name,
    minPrice: candidate.minPrice,
    sellP: candidate.sellP,
    vendorP: candidate.vendorP ?? 0,
    numAuctions: candidate.numAuctions,
    sellers: candidate.sellers ?? candidate.numAuctions,
    quantity: candidate.quantity ?? 10,
    itemClass: "Trade Goods",
    tiers: candidate.tiers ?? [{ p: candidate.minPrice, q: candidate.quantity ?? 10 }]
  })));
  lua.setPoints(candidates
    .filter((candidate) => candidate.closes)
    .map((candidate) => ({ itemId: candidate.itemId, closes: candidate.closes! })));
  lua.openTab();
  return lua;
}

describe("executable-profit radar", () => {
  it("lists a spread backed by depth and a sell front", () => {
    expect(radar([CLEAN]).names()).toEqual(["Clean Spread"]);
  });

  it("puts vendor arbitrage first even when a market trade earns more", () => {
    const deep = { ...CLEAN, itemId: 3577, name: "Deep Market", minPrice: 40000, sellP: 52000,
      closes: [50000, 52000, 54000],
      tiers: [{ p: 40000, q: 10 }, { p: 44000, q: 20 }] };
    expect(radar([deep, VENDOR]).names()).toEqual(["Vendor Flat [NPC必赚]", "Deep Market"]);
  });

  it("rejects a spread past the phase cap instead of calling it a deal", () => {
    const broken = { ...CLEAN, itemId: 1, name: "Broken Reference", minPrice: 300, sellP: 10000 };
    expect(radar([CLEAN, broken]).names()).toEqual(["Clean Spread"]);
  });

  it("requires the phase's book depth once history is credible", () => {
    // Wave commodity rules need three buyable listings.
    const thin = { ...CLEAN, itemId: 2, name: "Thin Book", numAuctions: 2 };
    expect(radar([CLEAN, thin], "wave").names()).toEqual(["Clean Spread"]);
  });

  it("admits a spread in ignition with no history at all", () => {
    const lonely = { ...CLEAN, itemId: 3, name: "No History", closes: undefined };
    expect(radar([lonely], "ignition").names()).toEqual(["No History"]);
  });

  it("ranks ignition opportunities by the demand prior, not only by net", () => {
    const shared = {
      itemId: 0, name: "", minPrice: 8000, sellP: 10000,
      numAuctions: 6, sellers: 3, quantity: 70,
      tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }],
      closes: [10000, 11000, 12000]
    };
    const bag = { ...shared, itemId: 10, name: "Bag", itemClass: "Container", itemSubClass: "Bag" };
    const armor = { ...shared, itemId: 11, name: "Armor", itemClass: "Armor", itemSubClass: "Mail" };
    const lua = loadAddon();
    lua.setScan([armor, bag].map((candidate) => ({
      itemId: candidate.itemId,
      name: candidate.name,
      minPrice: candidate.minPrice,
      sellP: candidate.sellP,
      numAuctions: candidate.numAuctions,
      sellers: candidate.sellers,
      quantity: candidate.quantity,
      itemClass: candidate.itemClass,
      itemSubClass: candidate.itemSubClass,
      tiers: candidate.tiers
    })));
    lua.setPoints([{ itemId: 10, closes: bag.closes }, { itemId: 11, closes: armor.closes }]);
    lua.openTab();
    expect(lua.names()).toEqual(["Bag", "Armor"]);
  });

  it("does not use a flat P10 series as a veto — the sell front is the anchor", () => {
    // The old radar refused a flat series because P10 was the reference.
    // Core prices the spread against the sell front; a flat history is
    // just a still market, not a broken reference.
    const flat = { ...CLEAN, itemId: 4, name: "Flat History", closes: [11000, 11000, 11000] };
    expect(radar([flat]).names()).toEqual(["Flat History"]);
  });
});

describe("cockpit status line", () => {
  it("states data age, breadth, phase and seller visibility", () => {
    const lua = radar([CLEAN]);
    const status = String(lua.eval("WowTest.ns.tradeFrame().status:GetText()"));
    expect(status).toContain("扫描于 0 分钟前");
    expect(status).toContain("在售 1 种");
    expect(status).toContain("点火期");
    expect(status).toContain("卖家可见 100%");
  });

  it("says there is no scan instead of rendering a stale-looking empty table", () => {
    const lua = loadAddon();
    lua.openTab();
    const status = String(lua.eval("WowTest.ns.tradeFrame().status:GetText()"));
    expect(status).toContain("尚未扫描");
  });
});
