import type { MarketSignal } from "@/lib/analytics";
import { formatWowMoney } from "@/lib/wow-money";

// Metrics an AlertRule may reference — the UI dropdown, the label table and
// the evaluator share this list as the single authority. Every entry is a
// real quote-derived statistic; gold-denominated ones are marked so the
// UI can convert user input from gold to copper.
export const alertMetricKeys = ["sellPrice", "minPrice", "sellRef", "spreadPercent", "trendPercent", "quantity", "numAuctions"] as const;

export type AlertMetricKey = (typeof alertMetricKeys)[number];

export const goldDenominatedMetrics: ReadonlySet<string> = new Set(["sellPrice", "minPrice", "sellRef"]);

// Keyed by the metric union so a new metric without a label is a type error.
export const alertMetricLabels: Record<AlertMetricKey, string> = {
  sellPrice: "建议卖价",
  minPrice: "最低价",
  sellRef: "卖价中位（窗口）",
  spreadPercent: "价差%（对卖价）",
  trendPercent: "趋势%（对中位）",
  quantity: "在售量",
  numAuctions: "挂单数"
};

const percentMetrics: ReadonlySet<string> = new Set(["spreadPercent", "trendPercent"]);

// One formatter for rule thresholds and live values: the same rule must
// read the same way in the cockpit alert panel and on the item page.
export function formatAlertValue(metric: string, value: number): string {
  if (goldDenominatedMetrics.has(metric)) return formatWowMoney(value);
  if (percentMetrics.has(metric)) return `${value.toFixed(2)}%`;
  return String(Math.round(value));
}

type RuleShape = {
  id: string;
  itemId: number;
  metric: string;
  operator: string;
  threshold: number;
  enabled: boolean;
};

type TriggeredAlert = { rule: RuleShape; signal: MarketSignal; actual: number };

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
