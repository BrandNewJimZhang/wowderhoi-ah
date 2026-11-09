// One consistent slice of everything a page renders. The market observation,
// the materialised signals, the reconciled holdings and the newest plan are
// read in one transaction; an import that lands between two independent
// reads cannot leave the page mixing two generations or two estate
// revisions.
import { prisma } from "@/lib/prisma";
import { decodeGeneration } from "@/lib/generation-record";
import { decodeSignalRow } from "@/lib/signal-row";
import { createMarketReader, type MarketBundle } from "@/lib/market-read";
import { resolveMarketScope } from "@/lib/market-scope";
import { GENERATION_SELECT, type StoredHolding } from "@/lib/repositories";

type StoredPlan = {
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

type StoredEstate = {
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

export async function getMarketView(): Promise<MarketView> {
  return prisma.$transaction(async (tx) => {
    const reader = createMarketReader({
      getMarketScope: () => resolveMarketScope(tx),
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
          character: true, itemId: true, qty: true, carriedQty: true, keyringQty: true,
          bankQty: true, accountBankQty: true, mailQty: true, listedQty: true, knownQty: true,
          unknownQty: true, missingQty: true, costKnown: true, costBasis: true
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
      // Only one plan is current. A delayed or same-second plan can leave
      // two rows at the top of a createdAt ordering; the superseded marker
      // is the authority, not the timestamp tie.
      tx.plan.findFirst({
        where: { marketId: scope.id, supersededAt: null },
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
