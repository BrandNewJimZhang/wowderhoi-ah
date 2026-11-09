// One-time migration from the scan-frozen `Market.cash/character/bagSlots`
// and the `Position` table to the character-scoped Estate and Holding read
// model. `prisma db push` drops the old columns and table, so the script
// dumps them to data/state-migration-<timestamp>.json first, pushes the new
// schema, then writes the seeded estate and holdings.
//
// Run once per database: `npm run state:migrate`.
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

type OldMarket = {
  id: string;
  realm: string;
  faction: string;
  cash: number | null;
  character: string | null;
  bag_slots: number | null;
};

type OldPosition = {
  market_id: string;
  item_id: number;
  qty: number;
  cost_basis: number;
};

export const MIGRATED_COVERAGE = {
  carried: "unobserved",
  bank: "unobserved",
  mail: "unobserved",
  listed: "unobserved",
  money: "observed"
} as const;

// A Position row is the ledger's known quantity: the old import rebuilt it
// from the journal. Seeding knownQty from it preserves the cost basis; the
// next estate push reconciles the locations. No location is claimed here:
// the old model never observed the bag, so `carriedQty` must stay 0 while
// `MIGRATED_COVERAGE.carried` is unobserved.
export function holdingSeed(row: OldPosition) {
  return {
    qty: row.qty,
    carriedQty: 0,
    knownQty: row.qty,
    unknownQty: 0,
    missingQty: 0,
    costBasis: row.cost_basis
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("Market")`);
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("cash") && !names.has("character")) {
      console.log("No legacy Market.cash/character columns; nothing to migrate.");
      return;
    }
    const markets = await prisma.$queryRawUnsafe<OldMarket[]>(
      `SELECT "id", "realm", "faction", "cash", "character", "bag_slots" FROM "Market"`
    );
    let positions: OldPosition[] = [];
    try {
      positions = await prisma.$queryRawUnsafe<OldPosition[]>(
        `SELECT "market_id", "item_id", "qty", "cost_basis" FROM "Position"`
      );
    } catch {
      console.log("No legacy Position table; only estate seeds will be written.");
    }
    const backup = `data/state-migration-${Date.now()}.json`;
    writeFileSync(backup, JSON.stringify({ markets, positions }, null, 2));
    console.log(`Legacy rows backed up to ${backup}`);

    execFileSync("npx", ["prisma", "db", "push", "--accept-data-loss", "--skip-generate"], {
      stdio: "inherit",
      env: process.env,
      shell: true
    });

    for (const row of markets) {
      const character = row.character ?? "";
      if (!character) continue;
      // Old generations default to an empty character; the market was
      // single-character under the old model, so attribute them to it.
      await prisma.marketGeneration.updateMany({
        where: { marketId: row.id, character: "" },
        data: { character }
      });
      await prisma.estate.upsert({
        where: { marketId_scope: { marketId: row.id, scope: `character:${character}` } },
        create: {
          marketId: row.id,
          scope: `character:${character}`,
          revision: 1,
          observedAt: new Date(),
          cash: row.cash ?? 0,
          freeSlots: row.bag_slots,
          coverage: MIGRATED_COVERAGE
        },
        update: {
          cash: row.cash ?? 0,
          freeSlots: row.bag_slots,
          coverage: MIGRATED_COVERAGE
        }
      });
    }
    for (const row of positions) {
      const market = markets.find((entry) => entry.id === row.market_id);
      const character = market?.character ?? "";
      if (!character) continue;
      await prisma.holding.upsert({
        where: {
          marketId_character_itemId: {
            marketId: row.market_id,
            character,
            itemId: row.item_id
          }
        },
        create: {
          marketId: row.market_id,
          character,
          itemId: row.item_id,
          ...holdingSeed(row)
        },
        update: holdingSeed(row)
      });
    }
    console.log(`Migrated ${markets.length} markets and ${positions.length} positions.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.loadEnvFile?.();
  await main();
}
