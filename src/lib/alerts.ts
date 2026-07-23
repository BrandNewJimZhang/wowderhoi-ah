import type { MarketSignal } from "@/lib/analytics";

// Metrics an AlertRule may reference — the UI dropdown and the evaluator
// share this list as the single authority. Every entry is a real
// snapshot-derived statistic; gold-denominated ones are marked so the
// UI can convert user input from gold to copper.
export const alertMetricKeys = ["price", "minPrice", "med7", "discountPercent", "quantity"] as const;

export type AlertMetricKey = (typeof alertMetricKeys)[number];

export const goldDenominatedMetrics: ReadonlySet<string> = new Set(["price", "minPrice", "med7"]);

type RuleShape = {
  id: string;
  itemId: number;
  metric: string;
  operator: string;
  threshold: number;
  enabled: boolean;
};

export type TriggeredAlert = { rule: RuleShape; signal: MarketSignal; actual: number };

export function evaluateAlertRules(rules: RuleShape[], signals: MarketSignal[]): TriggeredAlert[] {
  const byItemId = new Map(signals.map((signal) => [signal.itemId, signal]));
  const triggered: TriggeredAlert[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const signal = byItemId.get(rule.itemId);
    if (!signal) continue; // item not scanned yet — nothing to evaluate
    if (!alertMetricKeys.includes(rule.metric as AlertMetricKey)) {
      throw new Error(`AlertRule ${rule.id}: unknown metric "${rule.metric}"`);
    }
    const actual = signal[rule.metric as AlertMetricKey];
    const hit = rule.operator === "gt" ? actual > rule.threshold : actual < rule.threshold;
    if (hit) triggered.push({ rule, signal, actual });
  }
  return triggered;
}
