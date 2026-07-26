import { describe, expect, it } from "vitest";
import { normalizeAddonScan, parseSavedVariables } from "@/lib/addon-scan";

const savedVariablesFixture = `
WoWderhoiAH_ScanData = {
\t["dataVersion"] = 3,
\t["scannedAt"] = 1721700000,
\t["server"] = "Anniversary",
\t["faction"] = "Alliance",
\t["items"] = {
\t\t[2770] = {
\t\t\t["name"] = "铜矿石",
\t\t\t["quality"] = 1,
\t\t\t["itemClass"] = "商品",
\t\t\t["itemSubClass"] = "金属与矿石",
\t\t\t["minPrice"] = 150,
\t\t\t["marketPrice"] = 182.5,
\t\t\t["quantity"] = 240,
\t\t\t["numAuctions"] = 12,
\t\t\t["vendorP"] = 25,
\t\t},
\t\t[13468] = {
\t\t\t["name"] = "Black \\"Lotus\\"",
\t\t\t["quality"] = 3,
\t\t\t["minPrice"] = 950000,
\t\t\t["marketPrice"] = 987654,
\t\t\t["quantity"] = 3,
\t\t\t["numAuctions"] = 3,
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
    expect(scan.items).toHaveLength(2);
    const copperOre = scan.items.find((item) => item.itemId === 2770);
    expect(copperOre).toEqual({
      itemId: 2770,
      name: "铜矿石",
      quality: "common",
      category: "商品",
      subCategory: "金属与矿石",
      minPrice: 150,
      marketPrice: 183,
      quantity: 240,
      numAuctions: 12,
      vendorPrice: 25
    });
    const blackLotus = scan.items.find((item) => item.itemId === 13468);
    expect(blackLotus?.quality).toBe("rare");
    expect(blackLotus?.category).toBe("unknown");
    // Entries without vendorP (unsellable-to-NPC items) normalize to 0.
    expect(blackLotus?.vendorPrice).toBe(0);
  });

  it("rejects payloads without items", () => {
    expect(() => normalizeAddonScan({ dataVersion: 3, scannedAt: 1721700000, server: "A", faction: "Alliance", items: {} }))
      .toThrow(/items/i);
  });

  it("rejects entries with non-positive prices", () => {
    const broken = {
      dataVersion: 3,
      scannedAt: 1721700000,
      server: "Anniversary",
      faction: "Horde",
      items: { 2770: { name: "铜矿石", quality: 1, minPrice: 0, marketPrice: 0, quantity: 1, numAuctions: 1 } }
    };
    expect(() => normalizeAddonScan(broken)).toThrow(/minPrice/i);
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
    // dataVersion 2 carried a P50 marketPrice; the P10 rework redefined that
    // field, so v2 scans must be rejected rather than silently mixed in.
    expect(() => normalizeAddonScan({ ...stale, dataVersion: 2 })).toThrow(/dataVersion/i);
  });
});
