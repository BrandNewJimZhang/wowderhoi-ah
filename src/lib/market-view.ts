// One consistent slice of everything a page renders. The market observation,
// the materialised signals, the reconciled holdings and the newest plan are
// read in one transaction; an import that lands between two independent
// reads cannot leave the page mixing two generations or two estate
// revisions.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { decodeGeneration } from "@/lib/generation-record";
import { decodeSignalRow } from "@/lib/signal-row";
import { createMarketReader, type MarketBundle } from "@/lib/market-read";
import { parseMarketPin, type MarketScope } from "@/lib/market-scope";
import { GENERATION_SELECT, type StoredHolding } from "@/lib/repositories";

export type StoredPlan = {
  id: string;
  revision: string;
  estateRevision: number;
  ledgerRevision: number;
  configRevision: string;
  steps: unknown;
  resources: unknown;
  unplanned: unknown;
  source: string;
  createdAt: Date;
  supersededAt: Date | null;
};

export type StoredEstate = {
  scope: string;
  revision: number;
  observedAt: Date;
  cash: number | null;
  freeSlots: number | null;
  pendingCash: number | null;
  coverage: unknown;
};

export type MarketView = MarketBundle & {
  holdings: StoredHolding[];
  estates: StoredEstate[];
  plan: StoredPlan | null;
};

type Tx = Prisma.TransactionClient;

async function scopeFor(tx: Tx): Promise<MarketScope | null> {
  const pin = parseMarketPin(process.env.AQT_MARKET);
  let market = pin
    ? await tx.market.findUnique({ where: { realm_faction: pin } })
    : null;
  if (pin && !market) {
    throw new Error(`AQT_MARKET points at ${pin.realm}|${pin.faction}, but no such market has been imported`);
  }
  if (!market) {
    const latest = await tx.marketGeneration.findFirst({
      orderBy: { scannedAt: "desc" },
      select: { marketId: true }
    });
    if (latest) market = await tx.market.findUnique({ where: { id: latest.marketId } });
  }
  if (!market) market = await tx.market.findFirst({ orderBy: { createdAt: "asc" } });
  if (!market) return null;
  const generation = await tx.marketGeneration.findFirst({
    where: { marketId: market.id },
    orderBy: { scannedAt: "desc" },
    select: { character: true }
  });
  const character = generation?.character ?? "";
  const estate = character
    ? await tx.estate.findUnique({
        where: { marketId_scope: { marketId: market.id, scope: `character:${character}` } },
        select: { cash: true, freeSlots: true, revision: true }
      })
    : null;
  return {
    id: market.id,
    realm: market.realm,
    faction: market.faction,
    cash: estate?.cash ?? null,
    character,
    bagSlots: estate?.freeSlots ?? null,
    estateRevision: estate?.revision ?? 0,
    openedAt: market.openedAt,
    firstScanAt: market.firstScanAt,
    dataVersion: market.dataVersion
  };
}

export async function getMarketView(): Promise<MarketView> {
  return prisma.$transaction(async (tx) => {
    const reader = createMarketReader({
      getMarketScope: () => scopeFor(tx),
      getLatestGeneration: async (scope) => {
        const row = await tx.marketGeneration.findFirst({
          where: scope ? { marketId: scope.id } : {},
          orderBy: { scannedAt: "desc" },
          select: GENERATION_SELECT
        });
        return row ? decodeGeneration(row) : null;
      },
      getSignals: async (generationId) => {
        const rows = await tx.marketSignalRow.findMany({
          where: { generationId },
          select: { data: true },
          orderBy: { itemId: "asc" }
        });
        return rows.map((row) => decodeSignalRow(row.data));
      }
    });
    const bundle = await reader.getMarketBundle();
    const scope = bundle.scope;
    if (!scope) {
      return { ...bundle, holdings: [], estates: [], plan: null };
    }
    const [holdings, estates, plan] = await Promise.all([
      tx.holding.findMany({
        where: { marketId: scope.id },
        orderBy: [{ character: "asc" }, { itemId: "asc" }],
        select: {
          character: true, itemId: true, qty: true, carriedQty: true, bankQty: true,
          accountBankQty: true, mailQty: true, listedQty: true, knownQty: true,
          unknownQty: true, missingQty: true, costBasis: true
        }
      }),
      tx.estate.findMany({
        where: { marketId: scope.id },
        orderBy: { scope: "asc" },
        select: {
          scope: true, revision: true, observedAt: true, cash: true, freeSlots: true,
          pendingCash: true, coverage: true
        }
      }),
      tx.plan.findFirst({
        where: { marketId: scope.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, revision: true, estateRevision: true, ledgerRevision: true,
          configRevision: true, steps: true, resources: true, unplanned: true,
          source: true, createdAt: true, supersededAt: true
        }
      })
    ]);
    return { ...bundle, holdings, estates, plan };
  });
}
