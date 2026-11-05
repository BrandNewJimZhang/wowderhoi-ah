// Controlled listing experiments: the only way to learn demand at a price
// from your own actions. The plan is deliberately small — a few units at
// a few price levels — so a wrong belief costs little and the fill times
// are attributable to the price rather than to a market-wide shock.
import { median } from "@/lib/median";

export type ExperimentLevel = { price: number; qty: number };

export type ExperimentPlan = {
  itemId: number;
  levels: ExperimentLevel[];
  horizonHours: number;
  note: string;
};

// Prices are spaced around the sell front: one undercut level, the front
// itself, and one optimistic level. Inventory is split as evenly as the
// integer lots allow.
export type ExperimentTrade = {
  itemId: number;
  price: number;
  qty: number;
  listedAt: Date | null;
  realizedAt: Date;
  inferred: boolean;
};

export type ExperimentResult = {
  price: number; // the price a confirmed sale was booked at, copper per unit
  filled: number; // confirmed sales booked at this price
  units: number;
  medianHours: number | null; // listing time until the sale was observed
};

// Recovery is descriptive, not a fill rate: unsold listings are not
// persisted, so a price level with no sale is simply absent, never a 0%.
//
// Levels come from the sales themselves, not from a plan recomputed against
// today's sell front: the plan drifts as the market moves, and matching
// yesterday's sale against today's prices would report a filled level as
// unsold. The booked price is the only stable label of what was tested.
export function experimentResults(trades: ExperimentTrade[], itemId: number): ExperimentResult[] {
  const byPrice = new Map<number, { filled: number; units: number; hours: number[] }>();
  for (const trade of trades) {
    if (trade.inferred || trade.itemId !== itemId || trade.listedAt === null) continue;
    const bucket = byPrice.get(trade.price) ?? { filled: 0, units: 0, hours: [] };
    bucket.filled += 1;
    bucket.units += trade.qty;
    bucket.hours.push((trade.realizedAt.getTime() - trade.listedAt.getTime()) / (60 * 60 * 1000));
    byPrice.set(trade.price, bucket);
  }
  return Array.from(byPrice.entries())
    .sort(([left], [right]) => left - right)
    .map(([price, bucket]) => ({
      price,
      filled: bucket.filled,
      units: bucket.units,
      medianHours: median(bucket.hours)
    }));
}

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
