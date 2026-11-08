// Projects data/items.forever.json into the Item table. The dataset is the
// authority for static facts; the import is idempotent and only writes rows
// whose fields actually moved.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/prisma";
import { CATALOG_SOURCE, diffCatalog, parseCatalogDataset } from "@/lib/item-catalog";

process.loadEnvFile();

const DATASET = fileURLToPath(new URL("../data/items.forever.json", import.meta.url));
const CREATE_BATCH = 1000;
const UPDATE_BATCH = 200;

async function main() {
  const dataset = parseCatalogDataset(JSON.parse(readFileSync(DATASET, "utf8")));
  const existing = await prisma.item.findMany({
    select: {
      itemId: true, name: true, quality: true, category: true, subCategory: true,
      vendorPrice: true, iconId: true, itemLevel: true, requiredLevel: true,
      slot: true, typeLabel: true, catalogSource: true, catalogBuild: true
    }
  });
  const diff = diffCatalog(dataset.items, existing, dataset.build);
  console.log(
    `Catalogue ${dataset.source} build ${dataset.build}: ${dataset.items.length} rows, `
    + `${diff.creates.length} new, ${diff.updates.length} changed, `
    + `${dataset.items.length - diff.creates.length - diff.updates.length} unchanged.`
  );

  for (let index = 0; index < diff.creates.length; index += CREATE_BATCH) {
    const batch = diff.creates.slice(index, index + CREATE_BATCH);
    await prisma.item.createMany({
      data: batch.map((item) => ({
        ...item,
        catalogSource: CATALOG_SOURCE,
        catalogBuild: dataset.build
      }))
    });
  }
  for (let index = 0; index < diff.updates.length; index += UPDATE_BATCH) {
    const batch = diff.updates.slice(index, index + UPDATE_BATCH);
    await prisma.$transaction(batch.map((row) => prisma.item.update({ where: { itemId: row.itemId }, data: row.data })));
  }

  const inCatalogue = new Set(dataset.items.map((item) => item.itemId));
  const quoted = await prisma.marketQuote.findMany({
    select: { itemId: true },
    distinct: ["itemId"]
  });
  const missing = quoted.filter((row) => !inCatalogue.has(row.itemId)).length;
  console.log(
    `Imported. ${missing} scanned item ids are outside the public catalogue and stay scan-owned.`
  );
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
