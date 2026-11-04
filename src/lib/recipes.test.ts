import { describe, expect, it } from "vitest";
import { dbRecipeToLp, loadRecipeDataset, toLpRecipe } from "@/lib/recipes";

describe("recipe dataset", () => {
  const dataset = loadRecipeDataset();

  it("contains the full Forever catalogue", () => {
    expect(dataset.total).toBe(2595);
    expect(dataset.recipes).toHaveLength(2595);
    expect(dataset.recipes.filter((recipe) => recipe.expansion === "forever").length).toBe(1147);
  });

  it("gives every recipe a profession and identifiable materials", () => {
    for (const recipe of dataset.recipes) {
      expect(recipe.id).toBeGreaterThan(0);
      expect(recipe.name).toBeTruthy();
      expect(recipe.profession).toBeTruthy();
      for (const material of recipe.materials) {
        expect(material.itemId).toBeGreaterThan(0);
        expect(material.qty).toBeGreaterThan(0);
      }
    }
  });

  it("keeps service recipes that produce no item", () => {
    // Enchantments and similar services have materials but no product.
    expect(dataset.recipes.some((recipe) => recipe.products.length === 0)).toBe(true);
  });

  it("maps a dataset row into the LP shape", () => {
    const recipe = dataset.recipes.find((entry) => entry.id === 1353)!;
    const lp = toLpRecipe(recipe);
    expect(lp.materials).toEqual([{ itemId: 2318, qty: 2 }, { itemId: 2320, qty: 1 }]);
    expect(lp.products).toEqual([{ itemId: 2302, qty: 1 }]);
  });

  it("maps a Prisma row's JSON columns into the same shape", () => {
    const lp = dbRecipeToLp({
      id: 1,
      name: "Test",
      profession: "裁缝",
      category: "布甲",
      materials: [{ itemId: 1, qty: 2 }],
      products: [{ itemId: 2, qty: 1 }]
    });
    expect(lp.materials).toEqual([{ itemId: 1, qty: 2 }]);
    expect(lp.products).toEqual([{ itemId: 2, qty: 1 }]);
  });
});
