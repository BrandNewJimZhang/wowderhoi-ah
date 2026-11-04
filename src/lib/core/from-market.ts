// Builds Core.lua's input from imported terminal data. The same input
// shape is assembled in-game by WAH.coreInput(), so the decision core sees
// identical market, history, position and capital fields on both sides.
import type { MarketSignal } from "@/lib/analytics";
import { demandFor } from "@/lib/demand";
import type { CoreInput, CoreMarketItem, Tier } from "@/lib/core/types";
import type { MarketHistory } from "@/lib/market-data";
import type { MarketPhase } from "@/lib/market-rules";

export type CoreBuildOptions = {
  now: Date;
  phase: MarketPhase;
  positions?: Record<number, { qty: number; cost: number }>;
  budgetCopper?: number;
  bagSlots?: number;
  stackSize?: number;
};

function parseTiers(value: unknown, fallback: Tier): Tier[] {
  if (!Array.isArray(value)) return [fallback];
  const tiers = value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      const p = typeof row.p === "number" ? row.p : null;
      const q = typeof row.q === "number" ? row.q : null;
      if (!p || !q || p <= 0 || q <= 0) return null;
      return { p, q };
    })
    .filter((entry): entry is Tier => entry !== null)
    .sort((left, right) => left.p - right.p);
  return tiers.length > 0 ? tiers : [fallback];
}

export function buildCoreInput(
  pairs: Array<{ history: MarketHistory; signal: MarketSignal }>,
  options: CoreBuildOptions
): CoreInput {
  const items: Record<number, CoreMarketItem> = {};
  let firstScanAt: number | null = null;
  let scannedAt: number | null = null;
  for (const { history, signal } of pairs) {
    const latest = [...history.snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()).at(-1);
    if (!latest) continue;
    const stamp = latest.timestamp.getTime();
    firstScanAt = firstScanAt === null ? stamp : Math.min(firstScanAt, stamp);
    scannedAt = scannedAt === null ? stamp : Math.max(scannedAt, stamp);
    items[signal.itemId] = {
      itemId: signal.itemId,
      name: signal.name,
      itemClass: signal.category,
      itemSubClass: undefined,
      vendorP: signal.vendorPrice,
      minPrice: signal.minPrice,
      sellP: signal.sellPrice,
      p5: signal.p5Price,
      p10: signal.price,
      quantity: signal.quantity,
      numAuctions: signal.numAuctions,
      sellers: signal.sellerCount,
      sellersInvisible: signal.sellersInvisible,
      bidOnly: signal.bidOnlyCount,
      inferredSold: signal.inferredSold,
      supplyGrowth: signal.supplyGrowth,
      elapsedHours: 0.25,
      demandPrior: demandFor(signal.category, history.subCategory),
      tiers: parseTiers(latest.topTiers, { p: signal.minPrice, q: Math.max(signal.quantity, 1) }),
      history: {
        sellRef: signal.sellRef,
        samples: signal.sellSamples,
        latest: signal.sellPrice,
        distinct: signal.sellDistinct
      }
    };
  }
  return {
    now: options.now.getTime() / 1000,
    market: {
      scannedAt: scannedAt ? scannedAt / 1000 : undefined,
      firstScanAt: firstScanAt ? firstScanAt / 1000 : undefined,
      items
    },
    capital: {
      cash: options.budgetCopper ?? 0,
      budget: options.budgetCopper ?? 0,
      mail: 0,
      escrow: 0
    },
    capacity: {
      bagSlots: options.bagSlots ?? 20,
      stackSize: options.stackSize ?? 20
    },
    positions: options.positions ?? {}
  };
}
