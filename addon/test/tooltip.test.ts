// The trader section belongs on item tooltips and nowhere else. The client
// shares one GameTooltip across item, spell and unit buttons, so a link that
// is not an item must never inherit the previous item's price panel.

import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

const SCAN = [
  {
    itemId: 4338, name: "Mageweave Cloth", minPrice: 8000, sellP: 10000,
    numAuctions: 6, sellers: 3, quantity: 70, itemClass: "Trade Goods",
    tiers: [{ p: 8000, q: 20 }, { p: 9000, q: 50 }]
  }
];

function auctionPage() {
  const lua = loadAddon();
  lua.setScan(SCAN);
  return lua;
}

describe("trader tooltip section", () => {
  it("appends the market block to an item hyperlink", () => {
    const lua = auctionPage();
    lua.exec(`GameTooltip:SetHyperlink("item:4338:0:0:0:0:0:0:0")`);
    expect(lua.tooltipText()).toContain("WoWderhoi AHelper");
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  it("does not inherit the last item when the hyperlink is a spell", () => {
    const lua = auctionPage();
    // A previously hovered item leaves its link in the shared tooltip. The
    // talent/spellbook button then sets a spell hyperlink; GetItem() still
    // reports the old item, but the spell link must not carry its panel.
    lua.exec(`
      GameTooltip._lines = {}
      GameTooltip._link = "|Hitem:4338:0:0:0|h[Mageweave Cloth]|h"
      GameTooltip._itemName = "Mageweave Cloth"
      GameTooltip:SetHyperlink("spell:116")
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
    expect(lua.tooltipText()).toBe("");
  });

  it("does not inherit the last item when the hyperlink is a unit", () => {
    const lua = auctionPage();
    lua.exec(`
      GameTooltip._lines = {}
      GameTooltip._link = "|Hitem:4338:0:0:0|h[Mageweave Cloth]|h"
      GameTooltip._itemName = "Mageweave Cloth"
      GameTooltip:SetHyperlink("player:Name")
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
  });

  it("rejects a battle pet link and a link that only contains item:", () => {
    const lua = auctionPage();
    lua.exec(`
      GameTooltip._lines = {}
      GameTooltip._link = "|Hitem:4338:0:0:0|h[Mageweave Cloth]|h"
      GameTooltip._itemName = "Mageweave Cloth"
      GameTooltip:SetHyperlink("battlepet:123")
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
    lua.exec(`
      GameTooltip._lines = {}
      GameTooltip:SetHyperlink("prefix-item:4338")
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
  });

  it("parses only anchored item links", () => {
    const lua = auctionPage();
    expect(lua.eval(`WowTest.ns.itemIdFromLink("spell:116")`)).toBeNull();
    expect(lua.eval(`WowTest.ns.itemIdFromLink("prefix-item:4338")`)).toBeNull();
    expect(lua.number(`WowTest.ns.itemIdFromLink("|Hitem:4338:0:0|h[Mageweave]|h")`)).toBe(4338);
    expect(lua.number(`WowTest.ns.itemIdFromLink("|cffa335ee|Hitem:4338:0:0|h[Mageweave]|h")`)).toBe(4338);
  });
});
