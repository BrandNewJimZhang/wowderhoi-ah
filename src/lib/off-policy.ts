// Off-policy evaluation for logged decisions.
//
// The log is descriptive: the addon recommends, the player acts, and the
// terminal only sees the trades that happened. With a propensity of 1
// (the log always chose the top action) importance weighting collapses to
// a matched average, which is why this module reports coverage and
// effective sample size next to the estimate. It never dresses a
// descriptive average up as a causal effect.

export type LoggedDecision = {
  id: string;
  itemId: number | null;
  kind: string; // buy | sell
  at: Date;
  propensity?: number | null; // P(logging policy chose this action); default 1
};

export type RealizedTrade = {
  itemId: number;
  pnl: number;
  realizedAt: Date;
  inferred?: boolean;
};

export type TargetPolicy = (decision: LoggedDecision) => boolean;

export type PolicyEstimate = {
  estimate: number; // weighted mean P&L of matched trades
  matched: number;
  decisions: number;
  coverage: number; // matched / decisions
  effectiveSampleSize: number;
  truncated: number; // weights clipped at maxWeight
};

export function evaluatePolicy(
  decisions: LoggedDecision[],
  trades: RealizedTrade[],
  policy: TargetPolicy,
  options?: { windowDays?: number; maxWeight?: number }
): PolicyEstimate {
  const windowMs = (options?.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const maxWeight = options?.maxWeight ?? 10;
  const sortedTrades = [...trades].sort((left, right) => left.realizedAt.getTime() - right.realizedAt.getTime());
  const used = new Set<number>();
  let weightSum = 0;
  let sumSquares = 0;
  let weightedPnl = 0;
  let matched = 0;
  let truncated = 0;
  for (const decision of decisions) {
    if (!policy(decision) || decision.itemId === null) continue;
    const tradeIndex = sortedTrades.findIndex((trade, index) =>
      !used.has(index)
      && trade.itemId === decision.itemId
      && trade.realizedAt.getTime() >= decision.at.getTime()
      && trade.realizedAt.getTime() - decision.at.getTime() <= windowMs
    );
    if (tradeIndex === -1) continue;
    used.add(tradeIndex);
    const propensity = decision.propensity && decision.propensity > 0 ? decision.propensity : 1;
    const rawWeight = 1 / propensity;
    const weight = Math.min(rawWeight, maxWeight);
    if (rawWeight > maxWeight) truncated += 1;
    weightSum += weight;
    sumSquares += weight * weight;
    weightedPnl += weight * sortedTrades[tradeIndex].pnl;
    matched += 1;
  }
  return {
    estimate: weightSum > 0 ? weightedPnl / weightSum : 0,
    matched,
    decisions: decisions.length,
    coverage: decisions.length > 0 ? matched / decisions.length : 0,
    effectiveSampleSize: sumSquares > 0 ? (weightSum * weightSum) / sumSquares : 0,
    truncated
  };
}

export type DecayBucket = {
  start: Date;
  end: Date;
  count: number;
  pnl: number;
  winRate: number;
};

export type DecayReport = {
  buckets: DecayBucket[];
  decaying: boolean;
  reason: string | null;
};

// Alpha decay: the edge in a strategy should be assumed to decay as
// competitors copy it. The report compares the latest window with the two
// before it; it does not claim significance from a handful of trades.
export function alphaDecay(trades: RealizedTrade[], options?: { windowDays?: number }): DecayReport {
  if (trades.length === 0) return { buckets: [], decaying: false, reason: null };
  const windowMs = (options?.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const sorted = [...trades].sort((left, right) => left.realizedAt.getTime() - right.realizedAt.getTime());
  const start = sorted[0].realizedAt.getTime();
  const buckets: DecayBucket[] = [];
  for (let bucketStart = start; bucketStart <= sorted[sorted.length - 1].realizedAt.getTime(); bucketStart += windowMs) {
    const bucketEnd = bucketStart + windowMs;
    const rows = sorted.filter((trade) => trade.realizedAt.getTime() >= bucketStart && trade.realizedAt.getTime() < bucketEnd);
    if (rows.length === 0) continue;
    const pnl = rows.reduce((sum, trade) => sum + trade.pnl, 0);
    buckets.push({
      start: new Date(bucketStart),
      end: new Date(bucketEnd),
      count: rows.length,
      pnl,
      winRate: rows.filter((trade) => trade.pnl > 0).length / rows.length
    });
  }
  // The reason is shown verbatim on the review page, so it is written in the
  // product language like every other UI string; it is not a log line.
  if (buckets.length < 3) return { buckets, decaying: false, reason: "窗口不足，无法判断衰减" };
  const latest = buckets[buckets.length - 1];
  const prior = buckets.slice(-3, -1);
  const priorWinRate = prior.reduce((sum, bucket) => sum + bucket.winRate, 0) / prior.length;
  if (latest.winRate < priorWinRate - 0.15) {
    return { buckets, decaying: true, reason: "胜率比前两个窗口下降超过 15 个百分点" };
  }
  if (latest.pnl < 0 && prior.every((bucket) => bucket.pnl > 0)) {
    return { buckets, decaying: true, reason: "已实现盈亏在前两个窗口为正后转为负" };
  }
  return { buckets, decaying: false, reason: null };
}
