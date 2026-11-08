import { describe, expect, it } from "vitest";
import { diffCatalog, normalizeCatalogDataset, parseCatalogDataset } from "@/lib/item-catalog";

const META = { build: "1.60.1.70862", fetchedAt: "2026-11-08T00:00:00.000Z" };

const RAW = {
  "25": { id: 25, cls: 2, sub: 7, icon: 135274, ilvl: 2, name: "破损的短剑", q: 1, req: 1, sell: 7, slot: "主手", weapon_type: "单手剑" },
  "39": { id: 39, cls: 4, sub: 1, icon: 134582, ilvl: 1, name: "新兵短裤", q: 0, req: 1, sell: 1, slot: "腿部", armor_type: "布甲" },
  "4470": { id: 4470, cls: 7, sub: 9, icon: 133944, ilvl: 1, name: "普通木柴", q: 1, req: 0 },
  "2460": { id: 2460, cls: 0, sub: 2, icon: 134743, hidden: true, name: "未公开物品 #2460" }
};

describe("normalizeCatalogDataset", () => {
  it("projects the public export onto the committed shape", () => {
    const dataset = normalizeCatalogDataset(RAW, META);
    expect(dataset.items.map((item) => item.itemId)).toEqual([25, 39, 4470]);
    expect(dataset.items[0]).toMatchObject({
      name: "破损的短剑",
      quality: "common",
      category: "武器",
      subCategory: "单手剑",
      vendorPrice: 7,
      iconId: 135274,
      itemLevel: 2,
      requiredLevel: 1,
      slot: "主手",
      typeLabel: "单手剑"
    });
  });

  it("treats an omitted vendor price as unsellable, not unknown", () => {
    const dataset = normalizeCatalogDataset(RAW, META);
    expect(dataset.items.find((item) => item.itemId === 4470)?.vendorPrice).toBe(0);
  });

  it("drops hidden records instead of importing a masked name", () => {
    const dataset = normalizeCatalogDataset(RAW, META);
    expect(dataset.items.some((item) => item.itemId === 2460)).toBe(false);
  });

  it("rejects a row whose id disagrees with its key", () => {
    expect(() => normalizeCatalogDataset({ ...RAW, "99": RAW["25"] }, META)).toThrow(/claims item id/);
  });

  it("rejects a malformed sell price", () => {
    expect(() => normalizeCatalogDataset({ "1": { ...RAW["25"], id: 1, sell: -1 } }, META)).toThrow(/sell price/);
  });
});

describe("parseCatalogDataset", () => {
  const dataset = normalizeCatalogDataset(RAW, META);

  it("round-trips the committed dataset", () => {
    expect(parseCatalogDataset(JSON.parse(JSON.stringify(dataset)))).toEqual(dataset);
  });

  it("rejects a dataset without provenance or with duplicate ids", () => {
    expect(() => parseCatalogDataset({ ...dataset, source: "elsewhere" })).toThrow(/source/);
    expect(() => parseCatalogDataset({ ...dataset, items: [dataset.items[0], dataset.items[0]] })).toThrow(/repeats/);
  });
});

describe("diffCatalog", () => {
  const dataset = normalizeCatalogDataset(RAW, META);

  it("creates missing rows", () => {
    const diff = diffCatalog(dataset.items, [], META.build);
    expect(diff.creates).toHaveLength(dataset.items.length);
    expect(diff.updates).toHaveLength(0);
  });

  it("updates only rows whose facts moved or whose source is still the scan", () => {
    const existing: Array<typeof dataset.items[number] & { catalogSource: string; catalogBuild: string | null }> =
      dataset.items.map((item) => ({
        ...item,
        catalogSource: "wuxianwow.com",
        catalogBuild: META.build
      }));
    expect(diffCatalog(dataset.items, existing, META.build).updates).toHaveLength(0);
    existing[0] = { ...existing[0], name: "#25", catalogSource: "scan", catalogBuild: null };
    const diff = diffCatalog(dataset.items, existing, META.build);
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0].data).toMatchObject({ name: "破损的短剑", catalogSource: "wuxianwow.com" });
  });

  it("overwrites a scan-derived zero vendor price with the catalogue value", () => {
    const existing = dataset.items.map((item) => ({
      ...item,
      vendorPrice: 0,
      catalogSource: "scan",
      catalogBuild: null
    }));
    const diff = diffCatalog(dataset.items, existing, META.build);
    expect(diff.updates.find((row) => row.itemId === 25)?.data.vendorPrice).toBe(7);
  });
});
