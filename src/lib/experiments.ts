// Controlled listing experiments: the only way to learn demand at a price
// from your own actions. The plan is deliberately small — a few units at
// a few price levels — so a wrong belief costs little and the fill times
// are attributable to the price rather than to a market-wide shock.

export type ExperimentLevel = { price: number; qty: number };

export type ExperimentPlan = {
  itemId: number;
  levels: ExperimentLevel[];
  horizonHours: number;
  note: string;
};

export type ExperimentOutcome = {
  price: number;
  qty: number;
  filled: number;
  timeToFillHours?: number;
};

export type ExperimentSummary = {
  fillRate: number;
  revenue: number;
  averageFillHours: number | null;
  bestPrice: number | null;
  conclusion: string;
};

// Prices are spaced around the sell front: one undercut level, the front
// itself, and one optimistic level. Inventory is split as evenly as the
// integer lots allow.
export function designExperiment(input: {
  itemId: number;
  sellP: number;
  inventory: number;
  levels?: number;
  stepPercent?: number;
  horizonHours?: number;
}): ExperimentPlan {
  const levelCount = Math.max(2, Math.min(5, Math.floor(input.levels ?? 3)));
  const stepPercent = input.stepPercent ?? 0.05;
  const inventory = Math.max(0, Math.floor(input.inventory));
  const base = Math.max(1, Math.floor(input.sellP));
  const prices: number[] = [];
  for (let index = 0; index < levelCount; index += 1) {
    const offset = (index - Math.floor(levelCount / 2)) * stepPercent;
    prices.push(Math.max(1, Math.round(base * (1 + offset))));
  }
  const perLevel = Math.floor(inventory / levelCount);
  const remainder = inventory - perLevel * levelCount;
  const levels = prices.map((price, index) => ({ price, qty: perLevel + (index < remainder ? 1 : 0) }));
  return {
    itemId: input.itemId,
    levels,
    horizonHours: input.horizonHours ?? 24,
    note: "小批量、多价位；记录每档成交时间。开服期不要用一次大单测试需求。"
  };
}

export function summarizeExperiment(plan: ExperimentPlan, outcomes: ExperimentOutcome[]): ExperimentSummary {
  const totalListed = plan.levels.reduce((sum, level) => sum + level.qty, 0);
  const filled = outcomes.reduce((sum, outcome) => sum + outcome.filled, 0);
  const revenue = outcomes.reduce((sum, outcome) => sum + outcome.filled * outcome.price, 0);
  const timed = outcomes.filter((outcome) => outcome.filled > 0 && outcome.timeToFillHours !== undefined);
  const weightedHours = timed.reduce((sum, outcome) => sum + (outcome.timeToFillHours ?? 0) * outcome.filled, 0);
  const filledInTimed = timed.reduce((sum, outcome) => sum + outcome.filled, 0);
  const best = [...outcomes].filter((outcome) => outcome.filled > 0).sort((left, right) => right.filled * right.price - left.filled * left.price)[0];
  return {
    fillRate: totalListed > 0 ? filled / totalListed : 0,
    revenue,
    averageFillHours: filledInTimed > 0 ? weightedHours / filledInTimed : null,
    bestPrice: best?.price ?? null,
    conclusion:
      filled === 0
        ? "全部未成交：这个价位高于市场，或该物品在观察窗内没有需求。"
        : filled >= totalListed
          ? "全部成交：需求至少覆盖了这个价位的全部供给，可以上调下一轮价位。"
          : "部分成交：低价档先成交，说明需求存在但对价格敏感；保留低价档，缩小高价档数量。"
  };
}
