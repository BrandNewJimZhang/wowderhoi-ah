// Lower median, shared by every window statistic. Core.lua's Core.median
// uses the same rule, so an even-length window resolves to the same sample
// in game and in the terminal.
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}
