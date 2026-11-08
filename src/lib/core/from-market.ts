// Builds Core.lua's input from imported terminal data. The same input
// shape is assembled in-game by WAH.coreInput(), so the decision core sees
// identical market, history, position and capital fields on both sides.
import type { MarketSignal } from "@/lib/analytics";
import { demandFor } from "@/lib/demand";
import type { CoreInput, CoreMarketItem, OwnSales, Tier } from "@/lib/core/types";
import type { MarketHistory } from "@/lib/market-data";
import { SCAN_INTERVAL_MINUTES, type MarketPhase } from "@/lib/market-rules";

type CoreBuildOptions = {
  now: Date;
  phase: MarketPhase;
  // The first scan of the market. The signal source reads it from the store;
  // without it the builder falls back to the oldest snapshot in the bundle.
  firstScanAt?: Date;
  positions?: Record<number, { qty: number; cost: number }>;
  ownSales?: OwnSales;
  budgetCopper?: number;
  // Scanned cash (GetMoney at the last scan). Distinct from the planning
  // budget; the core falls back to cash only when no budget is supplied.
  cashCopper?: number;
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
  // seconds since epoch, not milliseconds: Core.lua compares it with `now`.
  let firstScanAt = options.firstScanAt ? options.firstScanAt.getTime() / 1000 : null;
  for (const { history, signal } of pairs) {
    const ordered = [...history.snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    const latest = ordered.at(-1);
    if (!latest) continue;
    const previous = ordered.at(-2);
    // Same definition as the in-game scan: the gap between the two newest
    // snapshots, floored at the compiled scan interval.
    const scanFloor = SCAN_INTERVAL_MINUTES / 60;
    const elapsedHours = previous
      ? Math.max((latest.timestamp.getTime() - previous.timestamp.getTime()) / (60 * 60 * 1000), scanFloor)
      : scanFloor;
    // The first scan is the OLDEST snapshot, not the newest one: taking the
    // latest would make a live market look freshly opened and pin the core
    // to the ignition rules forever.
    const earliest = ordered[0].timestamp.getTime() / 1000;
    if (firstScanAt === null || earliest < firstScanAt) firstScanAt = earliest;
    const own = options.ownSales?.[signal.itemId];
    items[signal.itemId] = {
      name: signal.name,
      // The in-game builder passes the scan's quality; the terminal passes
      // the item row's quality so CoreRow quality is populated on both sides.
      quality: signal.quality,
      itemClass: signal.category,
      itemSubClass: history.subCategory,
      // The scan classified the book; only rows without a captured
      // classification fall back to the core's own derivation.
      marketType: signal.marketType ?? undefined,
      vendorP: signal.vendorPrice,
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
      demandPrior: demandFor(signal.category, history.subCategory),
      tiers: parseTiers(latest.topTiers, { p: signal.minPrice, q: Math.max(signal.quantity, 1) }),
      tierTruncated: signal.tierTruncated,
      // The scanner owns the history series and stamps the count; the
      // terminal's 48-snapshot page is a display window, not a sample
      // authority. Falling back to it let the two runtimes judge the same
      // scan on different sample counts.
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
    // The caller resolves the phase once from the store's true scan history
    // and breadth; the core must not re-derive it from whatever subset of
    // snapshots this bundle happens to carry.
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
      stackSize: options.stackSize ?? 20
    },
    positions: options.positions ?? {}
  };
}
