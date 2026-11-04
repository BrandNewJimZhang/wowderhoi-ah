import { describe, expect, it } from "vitest";
import { normalizeAddonScan, parseSavedVariables } from "@/lib/addon-scan";

const savedVariablesFixture = `
WoWderhoiAH_ScanData = {
\t["dataVersion"] = 4,
\t["scannedAt"] = 1721700000,
\t["server"] = "Anniversary",
\t["faction"] = "Alliance",
\t["character"] = "Tester",
\t["total"] = 15,
\t["items"] = {
\t\t[2770] = {
\t\t\t["name"] = "铜矿石",
\t\t\t["quality"] = 1,
\t\t\t["itemClass"] = "商品",
\t\t\t["itemSubClass"] = "金属与矿石",
\t\t\t["minPrice"] = 150,
\t\t\t["sellP"] = 200,
\t\t\t["p5"] = 160,
\t\t\t["marketPrice"] = 182.5,
\t\t\t["quantity"] = 240,
\t\t\t["numAuctions"] = 12,
\t\t\t["sellers"] = 7,
\t\t\t["bidOnly"] = 0,
\t\t\t["tiers"] = { { ["p"] = 150, ["q"] = 100 }, { ["p"] = 200, ["q"] = 140 } },
\t\t\t["expiring"] = { ["soon"] = 2, ["mid"] = 3, ["late"] = 7 },
\t\t\t["vendorP"] = 25,
\t\t},
\t\t[13468] = {
\t\t\t["name"] = "Black \\"Lotus\\"",
\t\t\t["quality"] = 3,
\t\t\t["minPrice"] = 950000,
\t\t\t["sellP"] = 960000,
\t\t\t["marketPrice"] = 987654,
\t\t\t["quantity"] = 3,
\t\t\t["numAuctions"] = 3,
\t\t\t["sellers"] = 3,
\t\t\t["tiers"] = { { ["p"] = 950000, ["q"] = 3 } },
\t\t},
\t\t[700] = {
\t\t\t["name"] = "Bid Only",
\t\t\t["quality"] = 1,
\t\t\t["minPrice"] = 0,
\t\t\t["bidOnly"] = 2,
\t\t\t["highestBid"] = 500,
\t\t},
\t},
}
WoWderhoiAH_Settings = {
\t["verbose"] = false,
}
`;

describe("parseSavedVariables", () => {
  it("parses WoW SavedVariables assignments into plain objects", () => {
    const parsed = parseSavedVariables(savedVariablesFixture);
    const scan = parsed.WoWderhoiAH_ScanData as Record<string, unknown>;
    expect(scan.scannedAt).toBe(1721700000);
    expect(scan.server).toBe("Anniversary");
    const items = scan.items as Record<string, Record<string, unknown>>;
    expect(items["2770"].name).toBe("铜矿石");
    expect(items["2770"].marketPrice).toBe(182.5);
    expect(items["13468"].name).toBe('Black "Lotus"');
    expect(parsed.WoWderhoiAH_Settings).toEqual({ verbose: false });
  });

  it("throws on unterminated tables instead of returning partial data", () => {
    expect(() => parseSavedVariables("WoWderhoiAH_ScanData = {\n[\"scannedAt\"] = 1,")).toThrow(/unterminated/i);
  });
});

describe("normalizeAddonScan", () => {
  const rawScan = () => parseSavedVariables(savedVariablesFixture).WoWderhoiAH_ScanData;

  it("normalizes a parsed scan into snapshot-ready rows", () => {
    const scan = normalizeAddonScan(rawScan());
    expect(scan.scannedAt).toEqual(new Date(1721700000 * 1000));
    expect(scan.server).toBe("Anniversary");
    expect(scan.faction).toBe("Alliance");
    expect(scan.character).toBe("Tester");
    expect(scan.total).toBe(15);
    // Bid-only entries are demand observations, not zero-priced markets.
    expect(scan.items).toHaveLength(3);
    expect(scan.items.find((item) => item.itemId === 700)).toMatchObject({
      priced: false,
      bidOnlyCount: 2,
      highestBid: 500,
      minPrice: 0,
      quantity: 0
    });
    const copperOre = scan.items.find((item) => item.itemId === 2770);
    expect(copperOre).toMatchObject({
      itemId: 2770,
      name: "铜矿石",
      quality: "common",
      category: "商品",
      priced: true,
      subCategory: "金属与矿石",
      minPrice: 150,
      marketPrice: 183,
      sellPrice: 200,
      p5Price: 160,
      quantity: 240,
      numAuctions: 12,
      sellerCount: 7,
      bidOnlyCount: 0,
      vendorPrice: 25
    });
    expect(copperOre?.tiers).toEqual([{ p: 150, q: 100 }, { p: 200, q: 140 }]);
    expect(copperOre?.expiring).toEqual({ soon: 2, mid: 3, late: 7 });
    const blackLotus = scan.items.find((item) => item.itemId === 13468);
    expect(blackLotus?.quality).toBe("rare");
    expect(blackLotus?.category).toBe("unknown");
    // Entries without vendorP (unsellable-to-NPC items) normalize to 0.
    expect(blackLotus?.vendorPrice).toBe(0);
  });

  it("rejects payloads without items", () => {
    expect(() => normalizeAddonScan({ dataVersion: 4, scannedAt: 1721700000, server: "A", faction: "Alliance", items: {} }))
      .toThrow(/items/i);
  });

  it("rejects entries with non-positive prices", () => {
    const broken = {
      dataVersion: 4,
      scannedAt: 1721700000,
      server: "Anniversary",
      faction: "Horde",
      items: { 2770: { name: "铜矿石", quality: 1, minPrice: 0, marketPrice: 0, sellP: 0, quantity: 1, numAuctions: 1 } }
    };
    expect(() => normalizeAddonScan(broken)).toThrow(/minPrice/i);
  });

  it("rejects the legacy single-edge flow field", () => {
    const legacy = {
      dataVersion: 4, scannedAt: 1721700000, server: "A", faction: "Alliance",
      items: { 1: { name: "Linen", quality: 1, minPrice: 100, marketPrice: 100, sellP: 100, quantity: 5, numAuctions: 1, inferredSold: 3 } }
    };
    expect(() => normalizeAddonScan(legacy)).toThrow(/inferredSoldLow/);
  });

  it("rejects an inverted inferred-flow interval", () => {
    const inverted = {
      dataVersion: 4, scannedAt: 1721700000, server: "A", faction: "Alliance",
      items: { 1: { name: "Linen", quality: 1, minPrice: 100, marketPrice: 100, sellP: 100, quantity: 5, numAuctions: 1, inferredSoldLow: 5, inferredSoldHigh: 2 } }
    };
    expect(() => normalizeAddonScan(inverted)).toThrow(/below inferredSoldLow/);
  });

  it("rejects a priced item without tiers instead of inventing a book", () => {
    const broken = {
      dataVersion: 4, scannedAt: 1721700000, server: "A", faction: "Alliance",
      items: { 1: { name: "No Book", quality: 1, minPrice: 100, sellP: 120, marketPrice: 110, quantity: 5, numAuctions: 2, tiers: { 1: { p: 0, q: 5 } } } }
    };
    expect(() => normalizeAddonScan(broken)).toThrow(/tiers/i);
  });

  it("rejects a scan that contains only bid-only entries", () => {
    const bidsOnly = {
      dataVersion: 4, scannedAt: 1721700000, server: "A", faction: "Alliance",
      items: { 1: { name: "Bid Only", quality: 1, minPrice: 0, bidOnly: 2 } }
    };
    expect(() => normalizeAddonScan(bidsOnly)).toThrow(/no priced items/i);
  });

  it("rejects non-object payloads with the offending shape named", () => {
    expect(() => normalizeAddonScan(null)).toThrow(/scan payload/i);
  });

  it("rejects scans from an outdated pricing pipeline", () => {
    const stale = {
      scannedAt: 1721700000,
      server: "Anniversary",
      faction: "Alliance",
      items: { 2770: { name: "铜矿石", quality: 1, minPrice: 100, marketPrice: 120, quantity: 5, numAuctions: 2 } }
    };
    expect(() => normalizeAddonScan(stale)).toThrow(/dataVersion/i);
    expect(() => normalizeAddonScan({ ...stale, dataVersion: 1 })).toThrow(/dataVersion/i);
    expect(() => normalizeAddonScan({ ...stale, dataVersion: 2 })).toThrow(/dataVersion/i);
    // v3 predates order-book capture and seller identities; mixing it into
    // a v4 series would silently lose the ladder.
    expect(() => normalizeAddonScan({ ...stale, dataVersion: 3 })).toThrow(/dataVersion/i);
  });
});
