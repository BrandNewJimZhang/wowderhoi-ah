// Fill probability is an estimate, never an observation. A listing priced at
// p joins the queue behind every cheaper unit in the book; the chance it
// sells within T is the chance that queue clears within T.
//
// This is the same formula as Core.fillWithin in addon/WoWDerhoiAH/Core.lua.
// The hazard is a share of the book per hour -- the unit the calibration
// script measures -- so the units leaving per hour are hazard x supply. A
// second rearrangement of this arithmetic is how the sell page and the radar
// came to quote different probabilities for the same item; the parity test
// in addon/test/sell-pricing.test.ts pins the two together.
//
// This curve is the bag-seller view: the goods were not taken out of the
// book, so everything at or below the listing price is ahead of it. The
// radar's point estimate describes the other case -- units bought out of the
// book and relisted -- where the purchase itself leaves the queue, so only
// the units it did not buy remain ahead.
export type FillTier = { p: number; q: number };
export type FillPoint = { price: number; fill: number; band: [number, number] };

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
  horizonHours = 24,
  band = 0.35,
  quantity = 1
): FillPoint[] {
  const qty = Math.max(1, quantity);
  const share = Math.max(hazardPerHour, 0);
  const book = Math.max(supply, 0);
  if (share <= 0) return [];
  let ahead = 0;
  return [...tiers]
    .sort((left, right) => left.p - right.p)
    .map((tier) => {
      // Units strictly cheaper than this price are in front of the listing.
      // The tier's own quantity joins the queue after this point.
      const queue = ahead + qty;
      // A book with no size has no queue: the share can only be applied to
      // the listing itself, matching Core.fillWithin's degraded branch.
      const fill = book > 0
        ? 1 - Math.exp(-share * book * horizonHours / queue)
        : 1 - Math.exp(-share * horizonHours);
      ahead += tier.q;
      return {
        price: tier.p,
        fill,
        band: [Math.max(0, fill * (1 - band)), Math.min(1, fill * (1 + band))] as [number, number]
      };
    });
}
