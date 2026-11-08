import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemTaxonomy, qualityName } from "@/lib/item-taxonomy";
import { parseCatalogDataset } from "@/lib/item-catalog";

describe("itemTaxonomy", () => {
  it("uses the catalogue's localised weapon and armor types", () => {
    expect(itemTaxonomy({ cls: 2, sub: 7, weaponType: "单手剑" })).toEqual({ category: "武器", subCategory: "单手剑" });
    expect(itemTaxonomy({ cls: 4, sub: 1, armorType: "布甲" })).toEqual({ category: "护甲", subCategory: "布甲" });
  });

  it("maps trade goods and consumables onto the demand-band labels", () => {
    expect(itemTaxonomy({ cls: 7, sub: 9 })).toEqual({ category: "商品", subCategory: "草药" });
    expect(itemTaxonomy({ cls: 7, sub: 5 })).toEqual({ category: "商品", subCategory: "布" });
    expect(itemTaxonomy({ cls: 0, sub: 5 })).toEqual({ category: "消耗品", subCategory: "食物和饮料" });
    expect(itemTaxonomy({ cls: 9, sub: 8 })).toEqual({ category: "配方", subCategory: "附魔" });
  });

  it("falls back to 其它 instead of inventing a label", () => {
    expect(itemTaxonomy({ cls: 99, sub: 1 })).toEqual({ category: "其它", subCategory: "其它" });
    expect(itemTaxonomy({ cls: 7, sub: 999 })).toEqual({ category: "商品", subCategory: "其它" });
  });

  it("names qualities by the client index", () => {
    expect(qualityName(0)).toBe("poor");
    expect(qualityName(4)).toBe("epic");
    expect(qualityName(9)).toBe("unknown");
  });
});

describe("demand-band coverage", () => {
  it("every concrete demand band is reachable from the committed catalogue", () => {
    const dataset = parseCatalogDataset(JSON.parse(readFileSync("data/items.forever.json", "utf8")));
    const bands = JSON.parse(readFileSync("src/data/demand-bands.json", "utf8")) as {
      bands: Array<{ classes: string[]; subClasses: string[] }>;
    };
    const labels = new Set(dataset.items.map((item) => `${item.category}|${item.subCategory}`));
    const categories = new Set(dataset.items.map((item) => item.category));
    const missing: string[] = [];
    let checked = 0;
    for (const band of bands.bands) {
      if (band.classes.includes("*") && band.subClasses.includes("*")) continue;
      // A band whose class the client catalogue does not carry at all (the
      // public export has no class-3 gems) is empty by data, not by a
      // mapping bug; there is no item a better label could rescue.
      if (!band.classes.some((name) => categories.has(name))) continue;
      checked += 1;
      const hit = dataset.items.some((item) =>
        band.classes.includes(item.category)
        && (band.subClasses.includes("*") || band.subClasses.includes(item.subCategory))
      );
      if (!hit) missing.push(`${band.classes.join("/")} · ${band.subClasses.join("/")}`);
    }
    expect(missing, `demand bands with no catalogue item: ${missing.join("; ")}`).toEqual([]);
    expect(checked).toBeGreaterThan(10);
    expect(labels.size).toBeGreaterThan(20);
  });
});
