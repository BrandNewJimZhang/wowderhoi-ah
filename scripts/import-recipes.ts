// Projects data/recipes.forever.json into the Recipe table. The dataset is
// the authority and the table is replaceable: every run clears and reloads
// it, so a partial import can never masquerade as the catalogue.
import { prisma } from "@/lib/prisma";
import { loadRecipeDataset } from "@/lib/recipes";

process.loadEnvFile();

const CHUNK = 400;

async function main() {
  const dataset = loadRecipeDataset();
  if (dataset.total !== dataset.recipes.length || dataset.recipes.length === 0) {
    throw new Error(`Recipe dataset is inconsistent: total ${dataset.total}, rows ${dataset.recipes.length}`);
  }
  const rows = dataset.recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    profession: recipe.profession,
    category: recipe.category,
    materials: recipe.materials,
    products: recipe.products,
  }));
  const statements = [prisma.recipe.deleteMany({})];
  for (let index = 0; index < rows.length; index += CHUNK) {
    statements.push(prisma.recipe.createMany({ data: rows.slice(index, index + CHUNK) }));
  }
  await prisma.$transaction(statements);
  console.log(`Imported ${rows.length} recipes from ${dataset.source}.`);
}

void main().finally(async () => prisma.$disconnect());
