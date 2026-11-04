// Projects data/recipes.forever.json into the Recipe table. The dataset is
// the authority and the table is replaceable: every run clears and reloads
// it, so a partial import can never masquerade as the catalogue.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/prisma";
import type { RecipeDataset } from "@/lib/recipes";

process.loadEnvFile();

const DATASET = fileURLToPath(new URL("../data/recipes.forever.json", import.meta.url));
const CHUNK = 400;

async function main() {
  const dataset = JSON.parse(readFileSync(DATASET, "utf8")) as RecipeDataset;
  if (dataset.total !== dataset.recipes.length || dataset.recipes.length === 0) {
    throw new Error(`Recipe dataset is inconsistent: total ${dataset.total}, rows ${dataset.recipes.length}`);
  }
  const rows = dataset.recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    profession: recipe.profession,
    category: recipe.category,
    expansion: recipe.expansion,
    effect: recipe.effect,
    minRank: recipe.minRank ?? undefined,
    skillUpRange: recipe.skillUpRange ?? undefined,
    materials: recipe.materials,
    products: recipe.products,
    productItemId: recipe.products[0]?.itemId ?? null,
    productQuantity: recipe.products[0]?.qty ?? 1
  }));
  const statements = [prisma.recipe.deleteMany({})];
  for (let index = 0; index < rows.length; index += CHUNK) {
    statements.push(prisma.recipe.createMany({ data: rows.slice(index, index + CHUNK) }));
  }
  await prisma.$transaction(statements);
  console.log(`Imported ${rows.length} recipes from ${dataset.source}.`);
}

void main().finally(async () => prisma.$disconnect());
