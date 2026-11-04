// The committed wuxianwow recipe export is the source of truth. The DB
// Recipe table is an imported projection; this module reads the file for
// tooling and tests, and maps either shape into the LP's input.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { LpRecipe } from "@/lib/craft-lp";

export type DatasetRecipe = {
  id: number;
  name: string;
  profession: string;
  category: string;
  expansion: "forever" | "classic";
  effect: string;
  minRank: number | null;
  skillUpRange: [number, number] | null;
  materials: Array<{ itemId: number; name: string; qty: number }>;
  products: Array<{ itemId: number; name: string; qty: number; quality?: number; ilvl?: number }>;
};

export type RecipeDataset = {
  source: string;
  fetchedAt: string;
  total: number;
  recipes: DatasetRecipe[];
};

let cached: RecipeDataset | null = null;

export function loadRecipeDataset(): RecipeDataset {
  if (cached) return cached;
  const file = path.join(process.cwd(), "data", "recipes.forever.json");
  cached = JSON.parse(readFileSync(file, "utf8")) as RecipeDataset;
  return cached;
}

export function toLpRecipe(recipe: DatasetRecipe): LpRecipe {
  return {
    id: recipe.id,
    name: recipe.name,
    profession: recipe.profession,
    category: recipe.category,
    materials: recipe.materials.map((material) => ({ itemId: material.itemId, qty: material.qty })),
    products: recipe.products.map((product) => ({ itemId: product.itemId, qty: product.qty }))
  };
}

export type DbRecipeShape = {
  id: number;
  name: string;
  profession: string;
  category: string;
  materials: unknown;
  products: unknown;
};

function rowsOf(value: unknown): Array<{ itemId: number; qty: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      if (typeof row.itemId !== "number" || typeof row.qty !== "number") return null;
      return { itemId: row.itemId, qty: row.qty };
    })
    .filter((entry): entry is { itemId: number; qty: number } => entry !== null);
}

export function dbRecipeToLp(recipe: DbRecipeShape): LpRecipe {
  return {
    id: recipe.id,
    name: recipe.name,
    profession: recipe.profession,
    category: recipe.category,
    materials: rowsOf(recipe.materials),
    products: rowsOf(recipe.products)
  };
}
