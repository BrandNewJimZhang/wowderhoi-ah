// Builds Core.lua's input from imported terminal data. The same input
// shape is assembled in-game by WAH.coreInput(), so the decision core sees
// identical market, history, position and capital fields on both sides.
import type { MarketSignal } from "@/lib/analytics";
import { demandFor } from "@/lib/demand";
import type { CoreInput, CoreMarketItem, CorePosition, OwnSales, Tier } from "@/lib/core/types";
import type { MarketQuote } from "@/lib/market-data";
import { SCAN_INTERVAL_MINUTES, type MarketPhase } from "@/lib/market-rules";

type CoreBuildOptions = {
  now: Date;
  phase: MarketPhase;
  // The market's first observation. The import resolves it once from the
  // store and the series; the core never re-derives it from a display window.
  firstScanAt?: Date;
  positions?: Record<number, CorePosition>;
  ownSales?: OwnSales;
  budgetCopper?: number;
  // Client cash (GetMoney, pushed by the estate). Distinct from the
  // planning budget; the core falls back to cash only when no budget is
  // supplied.
  cashCopper?: number;
  bagSlots?: number;
  freeSlots?: number;
  // realm|faction|genEpoch:estateRevision:ledgerRevision:phase:character.
  planRevision?: string;
};

// The addon's planner fixes a stack at 20 units; the terminal must send the
// same capacity or the two cores size the same bag differently.
const STACK_SIZE = 20;

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
  pairs: Array<{ signal: MarketSignal; quote: MarketQuote; previousAt: Date | null }>,
  options: CoreBuildOptions
): CoreInput {
  const items: Record<number, CoreMarketItem> = {};
  // seconds since epoch, not milliseconds: Core.lua compares it with `now`.
  const firstScanAt = options.firstScanAt ? options.firstScanAt.getTime() / 1000 : null;
  for (const { signal, quote, previousAt } of pairs) {
    // Same definition as the in-game scan: the gap between the two newest
    // series points, floored at the compiled scan interval.
    const scanFloor = SCAN_INTERVAL_MINUTES / 60;
    const elapsedHours = previousAt
      ? Math.max((quote.timestamp.getTime() - previousAt.getTime()) / (60 * 60 * 1000), scanFloor)
      : scanFloor;
    const own = options.ownSales?.[signal.itemId];
    items[signal.itemId] = {
      name: signal.name,
      // The in-game builder passes the scan's quality; the terminal passes
      // the item row's quality so CoreRow quality is populated on both sides.
      quality: signal.quality,
      itemClass: signal.category,
      itemSubClass: signal.subCategory,
      // The scan classified the book; only rows without a captured
      // classification fall back to the core's own derivation.
      marketType: signal.marketType ?? undefined,
      // Null means no source resolved the NPC price. Core.lua's `or 0`
      // then takes the no-vendor-arbitrage branch, which is fail-closed.
      vendorP: signal.vendorPrice ?? 0,
      minPrice: signal.minPrice,
      sellP: signal.sellPrice,
      quantity: signal.quantity,
      numAuctions: signal.numAuctions,
      sellers: signal.sellerCount,
      sellersInvisible: signal.sellersInvisible,
      ownerVisible: signal.ownerVisible,
      sellerHHI: signal.sellerHHI,
      topSellerShare: signal.topSellerShare,
      bidOnly: signal.bidOnlyCount,
      inferredSoldLow: signal.inferredSoldLow,
      inferredSoldHigh: signal.inferredSoldHigh,
      flowObserved: signal.flowObserved,
      supplyGrowth: signal.supplyGrowth,
      elapsedHours,
      ownSold: own?.qty ?? 0,
      ownSamples: own?.samples ?? 0,
      ownExposedHours: own?.exposedHours ?? 0,
      highestBid: signal.highestBid,
      demandPrior: demandFor(signal.category, signal.subCategory),
      tiers: parseTiers(quote.topTiers, { p: signal.minPrice, q: Math.max(signal.quantity, 1) }),
      tierTruncated: signal.tierTruncated,
      // The scanner stamps the count and the terminal's series answers
      // when it did not; a display page is not a sample authority.
      history: {
        samples: signal.historySamples ?? 0,
        // Null means the row predates the span stamp; the core then applies
        // the sample floor alone instead of fabricating a coverage of zero.
        ...(signal.historySpanHours === null ? {} : { spanHours: signal.historySpanHours })
      }
    };
  }
  return {
    now: options.now.getTime() / 1000,
    ...(options.planRevision ? { planRevision: options.planRevision } : {}),
    // The caller resolves the phase once from the generation's stored
    // breadth and the market's true first observation; the core must not
    // re-derive it from whatever quotes this read happens to carry.
    phaseOverride: options.phase,
    market: {
      firstScanAt: firstScanAt ?? undefined,
      items
    },
    capital: {
      // Undefined means "balance unknown" and lets the core fall back to
      // the planning budget; a reported 0 is an empty purse and funds
      // nothing.
      cash: options.cashCopper,
      budget: options.budgetCopper ?? 0
    },
    capacity: {
      bagSlots: options.bagSlots ?? 20,
      freeSlots: options.freeSlots ?? options.bagSlots ?? 20,
      stackSize: STACK_SIZE
    },
    positions: options.positions ?? {}
  };
}
