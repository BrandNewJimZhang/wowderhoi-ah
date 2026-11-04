// Fill probability is an estimate, never an observation. A listing priced at
// p joins the queue behind every cheaper unit in the book; the chance it
// sells within T is the chance that queue clears within T. The curve is
// anchored at the sell front: with nothing ahead of it, the estimate equals
// the core's fillProb, and a higher price clears strictly slower. The band
// makes the uncertainty visible.
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
  horizonHours = 24,
  band = 0.35,
  quantity = 1
): FillPoint[] {
  const qty = Math.max(1, quantity);
  let ahead = 0;
  return [...tiers]
    .sort((left, right) => left.p - right.p)
    .map((tier) => {
      // Units strictly cheaper than this price are in front of the listing.
      // The tier's own quantity joins the queue after this point.
      const hazard = hazardPerHour * qty / (ahead + qty);
      ahead += tier.q;
      const fill = 1 - Math.exp(-hazard * horizonHours);
      return {
        price: tier.p,
        fill,
        band: [Math.max(0, fill * (1 - band)), Math.min(1, fill * (1 + band))] as [number, number]
      };
    });
}
