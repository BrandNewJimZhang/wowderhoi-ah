// Percent changes can be genuinely astronomical in the opening days: one
// 1.1-million-gold listing after a few silver sales is a +billion-percent
// move. Print a bounded number so the column stays readable; the full
// value remains in the signal for anything that needs it.
const DISPLAY_PERCENT_LIMIT = 9999;

export function formatPercent(value: number) {
  if (Math.abs(value) > DISPLAY_PERCENT_LIMIT) {
    return value >= 0 ? `>${DISPLAY_PERCENT_LIMIT}%` : `<-${DISPLAY_PERCENT_LIMIT}%`;
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
