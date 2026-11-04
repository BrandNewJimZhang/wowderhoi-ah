// Position sizing and capital allocation. Fractional Kelly is only as
// good as its inputs: when the fill probability comes from a prior, the
// fraction is capped by the phase's exposure rules and the result is
// labelled as exploratory rather than optimal.

export type SizingConfig = {
  kappa: number; // fraction of full Kelly
  maxItemExposure: number; // share of capital in one item
  dailyBudget: number; // share of capital committed in a day
  minSamplesForKelly: number;
};

export type SizingOpportunity = {
  itemId: number;
  name: string;
  unitCost: number;
  sellPrice: number;
  feeRate: number;
  fillProb: number;
  residualValue?: number; // vendor / disenchant floor; 0 when unknown
  samples?: number;
};

export type PositionSize = {
  itemId: number;
  name: string;
  qty: number;
  budget: number;
  fraction: number;
  expectedNet: number;
  cappedBy: "kelly" | "item-exposure" | "daily-budget" | "capital" | "none";
  exploratory: boolean;
};

// Kelly for a bet with win probability p and net odds b = win/loss:
// f* = p - (1-p)/b. The loss is the cost minus the residual value, so an
// item with a vendor floor is a smaller bet than one with none.
export function kellyFraction(p: number, win: number, loss: number): number {
  if (win <= 0 || loss <= 0) return 0;
  const odds = win / loss;
  const fraction = p - (1 - p) / odds;
  return Math.max(0, Math.min(1, fraction));
}

export function sizePosition(
  opportunity: SizingOpportunity,
  availableCapital: number,
  config: SizingConfig,
  cap: number = availableCapital
): PositionSize {
  const win = opportunity.sellPrice * (1 - opportunity.feeRate) - opportunity.unitCost;
  const loss = Math.max(opportunity.unitCost - (opportunity.residualValue ?? 0), 1);
  const fullKelly = kellyFraction(opportunity.fillProb, win, loss);
  const fraction = fullKelly * config.kappa;
  const itemCap = availableCapital * config.maxItemExposure;
  const kellyBudget = availableCapital * fraction;
  let budget = Math.min(kellyBudget, itemCap, cap);
  let cappedBy: PositionSize["cappedBy"] = "kelly";
  if (budget === itemCap && itemCap <= kellyBudget) cappedBy = "item-exposure";
  if (budget === cap && cap < kellyBudget && cap < itemCap) cappedBy = "daily-budget";
  if (budget <= 0) cappedBy = "none";
  if (availableCapital <= 0) cappedBy = "capital";
  const qty = opportunity.unitCost > 0 ? Math.floor(budget / opportunity.unitCost) : 0;
  budget = qty * opportunity.unitCost;
  return {
    itemId: opportunity.itemId,
    name: opportunity.name,
    qty,
    budget,
    fraction,
    expectedNet: qty * win,
    cappedBy,
    exploratory: (opportunity.samples ?? 0) < config.minSamplesForKelly
  };
}

export function allocateCapital(
  opportunities: SizingOpportunity[],
  capital: number,
  config: SizingConfig
): PositionSize[] {
  let remaining = Math.max(0, capital * config.dailyBudget);
  const allocations: PositionSize[] = [];
  const ranked = [...opportunities].sort((left, right) => {
    const leftEdge = left.fillProb * (left.sellPrice * (1 - left.feeRate) - left.unitCost);
    const rightEdge = right.fillProb * (right.sellPrice * (1 - right.feeRate) - right.unitCost);
    return rightEdge - leftEdge;
  });
  for (const opportunity of ranked) {
    if (remaining <= 0) break;
    const sized = sizePosition(opportunity, capital, config, remaining);
    if (sized.qty > 0) {
      allocations.push(sized);
      remaining -= sized.budget;
    }
  }
  return allocations;
}
