// Fill probability is an estimate, never an observation. A listing priced at
// p joins the queue behind every cheaper unit in the book; the chance it
// sells within T is the chance that queue clears within T.
//
// This is the same formula as Core.fillWithin in addon/WoWDerhoiAH/Core.lua.
// The hazard is a share of the book per hour -- the unit the calibration
// script measures -- so the units leaving per hour are hazard x supply. A
// second rearrangement of this arithmetic is how the sell page and the radar
// came to quote different probabilities for the same item; the parity test
// in addon/test/fill-parity.test.ts pins the two together.
//
// This curve is the bag-seller view: the goods were not taken out of the
// book, so everything at or below the listing price is ahead of it. The
// radar's point estimate describes the other case -- units bought out of the
// book and relisted -- where the purchase itself leaves the queue, so only
// the units it did not buy remain ahead.
import type { FillBasis } from "@/lib/core/types";
import { fillRules } from "@/lib/market-rules";

type FillTier = { p: number; q: number };
type FillPoint = { price: number; fill: number; band: [number, number] };

// One label per evidence tier. The cockpit, the review table and the item
// chart used to keep three copies; the cockpit called every non-own basis
// "凯利", which named the sizing rule instead of the evidence.
export const fillBasisLabels: Record<FillBasis, string> = {
  own: "自有成交",
  proxy: "公共推断",
  "observed-zero": "观测为零",
  prior: "阶段先验",
  vendor: "NPC 收购"
};

// Decision rows store the basis as a plain string; unknown or missing values
// fall back to the label of the tier the core uses when nothing is observed.
// Core.lua resolves FILL_BASIS_TEXT the same way, so a tier this build does
// not know is reported as "prior" on both sides instead of leaking an
// untranslated identifier into the UI.
export function fillBasisLabel(basis: string | null | undefined): string {
  if (basis && basis in fillBasisLabels) return fillBasisLabels[basis as FillBasis];
  return fillBasisLabels.prior;
}

// Longer copy for the chart header, where the reader needs to know what the
// tier means rather than just its name.
export const fillBasisDescriptions: Record<Exclude<FillBasis, "vendor">, string> = {
  own: "基于自己的成交",
  proxy: "基于公共推断消失（区间）",
  "observed-zero": "盘口可观测且无消失（零观测收缩）",
  prior: "基于阶段先验（观测不可用）"
};

// The core reports the interval around its point estimate. The chart must
// draw the same uncertainty: a hardcoded band (35%) would show a prior
// estimate as tighter than the recommendation it is derived from.
export function bandFromInterval(point: number, low: number, high: number, fallback = 0.35): number {
  if (!(point > 0)) return fallback;
  return Math.max(0, (point - low) / point, (high - point) / point);
}

export function fillCurve(
  tiers: FillTier[],
  hazardPerHour: number,
  supply: number,
  horizonHours: number = fillRules.horizonHours,
  band = 0.35,
  quantity = 1
): FillPoint[] {
  const qty = Math.max(1, quantity);
  const share = Math.max(hazardPerHour, 0);
  const book = Math.max(supply, 0);
  if (share <= 0) return [];
  // One point per distinct price. Everything at or below this price is in
  // front of the listing -- including every unit already sitting at the same
  // price, which were listed earlier. Core.fillWithin and Core.sellPlan sum
  // all tiers at or below the price; leaving a duplicated row unmerged let
  // the first of them quote a shorter queue than the sell page on the same
  // book. Real scans aggregate by price, but the curve must not depend on
  // its input having been through that step.
  const merged: FillTier[] = [];
  for (const tier of [...tiers].sort((left, right) => left.p - right.p)) {
    const last = merged[merged.length - 1];
    if (last && last.p === tier.p) last.q += tier.q;
    else merged.push({ p: tier.p, q: tier.q });
  }
  let ahead = 0;
  return merged.map((tier) => {
    ahead += tier.q;
    const queue = ahead + qty;
    // A book with no size has no queue: the share can only be applied to
    // the listing itself, matching Core.fillWithin's degraded branch.
    const fill = book > 0
      ? 1 - Math.exp(-share * book * horizonHours / queue)
      : 1 - Math.exp(-share * horizonHours);
    return {
      price: tier.p,
      fill,
      band: [Math.max(0, fill * (1 - band)), Math.min(1, fill * (1 + band))] as [number, number]
    };
  });
}
