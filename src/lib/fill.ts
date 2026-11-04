// Fill probability is an estimate, never an observation. Given a hazard
// rate from own sales (or a phase prior when there are none), the chance
// of selling within T hours before the queue ahead of a price clears is
// modelled as an exponential. The band makes the uncertainty visible.
export type FillTier = { p: number; q: number };
export type FillPoint = { price: number; fill: number; band: [number, number] };

export function fillCurve(
  tiers: FillTier[],
  hazardPerHour: number,
  horizonHours = 24,
  band = 0.35
): FillPoint[] {
  const total = tiers.reduce((sum, tier) => sum + tier.q, 0);
  if (total <= 0) return [];
  let cumulative = 0;
  return [...tiers]
    .sort((left, right) => left.p - right.p)
    .map((tier) => {
      cumulative += tier.q;
      const share = cumulative / total;
      const fill = 1 - Math.exp(-hazardPerHour * horizonHours * share);
      return {
        price: tier.p,
        fill,
        band: [Math.max(0, fill * (1 - band)), Math.min(1, fill * (1 + band))] as [number, number]
      };
    });
}
