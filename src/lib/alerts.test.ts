import { describe, expect, it } from "vitest";
import type { MarketSignal } from "@/lib/analytics";
import { alertMetricKeys, evaluateAlertRules, goldDenominatedMetrics } from "@/lib/alerts";

function signal(partial: Partial<MarketSignal> & Pick<MarketSignal, "itemId" | "name">): MarketSignal {
  return {
    category: "unknown",
    quality: "common",
    price: 100,
    minPrice: 90,
    quantity: 0,
    numAuctions: 0,
    vendorPrice: 0,
    med7: 100,
    med7Samples: 1,
    med7Distinct: 1,
    discountPercent: 0,
    changePercent: 0,
    ...partial
  };
}

const signals = [
  signal({ itemId: 23424, name: "魔铁矿石", price: 5000, discountPercent: 22 }),
  signal({ itemId: 22785, name: "梦叶草", price: 800, quantity: 2000 })
];

describe("evaluateAlertRules", () => {
  it("triggers gt/lt rules against the matching item's metric", () => {
    const triggered = evaluateAlertRules(
      [
        { id: "a", itemId: 23424, metric: "discountPercent", operator: "gt", threshold: 15, enabled: true },
        { id: "b", itemId: 22785, metric: "quantity", operator: "gt", threshold: 1000, enabled: true },
        { id: "c", itemId: 23424, metric: "price", operator: "gt", threshold: 999999, enabled: true }
      ],
      signals
    );
    expect(triggered.map((hit) => hit.rule.id)).toEqual(["a", "b"]);
    expect(triggered[0].actual).toBe(22);
  });

  it("skips disabled rules and rules for unscanned items", () => {
    const triggered = evaluateAlertRules(
      [
        { id: "a", itemId: 23424, metric: "price", operator: "gt", threshold: 1, enabled: false },
        { id: "b", itemId: 99999, metric: "price", operator: "gt", threshold: 1, enabled: true }
      ],
      signals
    );
    expect(triggered).toHaveLength(0);
  });

  it("rejects unknown metrics loudly instead of silently skipping", () => {
    expect(() =>
      evaluateAlertRules([{ id: "a", itemId: 23424, metric: "tradingScore", operator: "gt", threshold: 1, enabled: true }], signals)
    ).toThrow(/tradingScore/);
  });

  it("marks price-shaped metrics as gold denominated for UI conversion", () => {
    expect(goldDenominatedMetrics.has("price")).toBe(true);
    expect(goldDenominatedMetrics.has("med7")).toBe(true);
    expect(goldDenominatedMetrics.has("discountPercent")).toBe(false);
    for (const key of goldDenominatedMetrics) expect(alertMetricKeys).toContain(key);
  });
});
