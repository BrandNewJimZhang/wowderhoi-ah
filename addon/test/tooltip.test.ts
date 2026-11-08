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

  it("appends the market block to an item in the bags", () => {
    const lua = auctionPage();
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
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

describe("modern tooltip pipeline", () => {
  // The 1.60 client resolves bag and chat items itself and posts the result
  // to the frame that owns the lines. That frame is the embedded
  // GameTooltipTooltip, not the GameTooltip global the old gate demanded.
  it("appends to the embedded tooltip frame the client names", () => {
    const lua = auctionPage();
    lua.exec(`
      WowTest.fireItemTooltip(GameTooltipTooltip,
        "|cffa335ee|Hitem:4338:0:0:0|h[Mageweave Cloth]|h", "Mageweave Cloth")
    `);
    expect(lua.tooltipTextNamed("GameTooltipTooltip")).toContain("WoWderhoi AHelper");
    expect(lua.tooltipTextNamed("GameTooltipTooltip")).toContain("建议卖价");
  });

  it("appends to the tooltip of a clicked chat item link", () => {
    const lua = auctionPage();
    lua.exec(`
      WowTest.fireItemTooltip(ItemRefTooltip,
        "|Hitem:4338:0:0:0|h[Mageweave Cloth]|h", "Mageweave Cloth")
    `);
    expect(lua.tooltipTextNamed("ItemRefTooltip")).toContain("建议卖价");
  });

  it("does not append twice when the client reposts the same tooltip", () => {
    const lua = auctionPage();
    lua.exec(`
      WowTest.fireItemTooltip(GameTooltipTooltip, "|Hitem:4338:0:0:0|h[Mageweave]|h", "Mageweave")
      WowTest.fireTooltipPost(Enum.TooltipDataType.Item, GameTooltipTooltip)
    `);
    const text = lua.tooltipTextNamed("GameTooltipTooltip");
    expect(text.split("WoWderhoi AHelper").length - 1).toBe(1);
  });

  it("keeps the setter fallback for pre-10.0.2 clients", () => {
    const lua = loadAddon({ legacyTooltips: true });
    lua.setScan(SCAN);
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.tooltipText()).toContain("WoWderhoi AHelper");
  });

  it("reads a native bag tooltip from the setter arguments", () => {
    // The client can render the lines natively: the post-call still fires
    // (or a setter hook does), but the frame itself exposes no displayed
    // item. The bag/slot arguments are the only authoritative source.
    const lua = auctionPage();
    lua.exec(`
      TooltipUtil.GetDisplayedItem = function() return nil end
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.tooltipText()).toContain("WoWderhoi AHelper");
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  it("does not raise when the client marks the link secret", () => {
    const lua = auctionPage();
    lua.exec(`
      issecretvalue = function() return true end
      GameTooltip:SetHyperlink("item:4338:0:0:0")
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
  });
});

describe("item observation", () => {
  // The typed TooltipData is the client's own answer: type=Item and id is
  // the item ID. It must resolve the item even when the frame reports no
  // hyperlink, no remembered item and no TooltipUtil answer.
  it("resolves an item from the typed tooltip data alone", () => {
    const lua = auctionPage();
    lua.exec(`
      TooltipUtil.GetDisplayedItem = function() return nil end
      GameTooltip.GetItem = function() return nil end
      WowTest.fireTooltipPost(Enum.TooltipDataType.Item, GameTooltip, { type = 0, id = 4338 })
    `);
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  it("appends from OnTooltipSetItem when the processor never fires", () => {
    const lua = loadAddon({ prelude: "TooltipDataProcessor.AddTooltipPostCall = function() end" });
    lua.setScan(SCAN);
    lua.exec(`
      GameTooltip._link = "|Hitem:4338:0:0|h[Mageweave Cloth]|h"
      GameTooltip._itemName = "Mageweave Cloth"
      GameTooltip._scripts.OnTooltipSetItem(GameTooltip)
    `);
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  it("appends from ProcessInfo data", () => {
    const lua = auctionPage();
    lua.exec(`GameTooltip:ProcessInfo({ type = 0, hyperlink = "|Hitem:4338:0:0|h[Mageweave Cloth]|h" })`);
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  // Two independent consumers: the tooltip switch silences the text block,
  // never the observation. The chart still moves to the hovered item.
  it("updates the chart while the tooltip block is switched off", () => {
    const lua = loadAddon();
    lua.setScan(SCAN);
    lua.openTab();
    lua.exec(`
      WowTest.ns.settings.tooltip = false
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.tooltipText()).not.toContain("WoWderhoi AHelper");
    expect(lua.number("WowTest.ns.chartState().itemId")).toBe(4338);
  });

  it("keeps the chart on the last item when a spell link is hovered", () => {
    const lua = loadAddon();
    lua.setScan(SCAN);
    lua.openTab();
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
      GameTooltip:SetHyperlink("spell:116")
    `);
    expect(lua.number("WowTest.ns.chartState().itemId")).toBe(4338);
  });

  it("does not force a hidden tooltip open to append", () => {
    const lua = auctionPage();
    lua.exec(`WowTest.fireTooltipPost(Enum.TooltipDataType.Item, GameTooltip, { type = 0, id = 4338 })`);
    expect(lua.tooltipText()).toContain("建议卖价");
    expect(lua.eval("GameTooltip:IsShown()")).toBe(false);
  });
});

describe("tooltip pipeline diagnostics", () => {
  // A failed hook registration must not take the rest of the file down.
  // /wahtip is registered before any hook so the command survives, and the
  // failure is recorded instead of vanishing into a silent load abort.
  it("keeps /wahtip available when a hook registration raises", () => {
    const lua = loadAddon({ prelude: "hooksecurefunc = function() error('hook boom') end" });
    expect(lua.eval("type(SlashCmdList['WOWDERHOIAHTIP'])")).toBe("function");
    lua.exec("SlashCmdList['WOWDERHOIAHTIP']('')");
    expect(lua.anyChat("hook boom")).toBe(true);
  });

  // The mixed pipeline: the processor exists, but a native setter-rendered
  // tooltip never reaches it. The setter hook alone must still append.
  it("appends through the setter when the processor never fires", () => {
    const lua = loadAddon({ prelude: "TooltipDataProcessor.AddTooltipPostCall = function() end" });
    lua.setScan(SCAN);
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
    `);
    expect(lua.tooltipText()).toContain("建议卖价");
  });

  it("names the pipeline facts and the last events", () => {
    const lua = auctionPage();
    lua.exec(`
      WowTest.bagItems[1] = { itemId = 4338, name = "Mageweave Cloth" }
      GameTooltip:SetBagItem(0, 1)
      SlashCmdList["WOWDERHOIAHTIP"]("")
    `);
    expect(lua.anyChat("processor=true")).toBe(true);
    expect(lua.anyChat("appended")).toBe(true);
  });
});
