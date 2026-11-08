// Lower median, shared by every window statistic. Core.lua's Core.median
// uses the same rule, so an even-length window resolves to the same sample
// in game and in the terminal.
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

// Nearest-rank quantile, anchored on the same lower-middle convention as
// median: q=0.5 returns exactly median(values). Used for the price band the
// market table draws, not for any decision.
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(Math.max(Math.ceil(q * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[rank];
}
