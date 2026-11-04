import { describe, expect, it } from "vitest";
import type { MarketSignal } from "@/lib/analytics";
import { alertMetricKeys, evaluateAlertRules, goldDenominatedMetrics } from "@/lib/alerts";

function signal(partial: Partial<MarketSignal> & Pick<MarketSignal, "itemId" | "name">): MarketSignal {
  return {
    category: "unknown",
    quality: "common",
    sellPrice: 100,
    minPrice: 90,
    p5Price: 90,
    price: 100,
    quantity: 0,
    numAuctions: 0,
    sellerCount: 0,
    sellersInvisible: false,
    bidOnlyCount: 0,
    inferredSold: 0,
    supplyGrowth: 0,
    vendorPrice: 0,
    sellRef: 100,
    sellSamples: 1,
    sellDistinct: 1,
    p10Median: 100,
    spreadPercent: 10,
    trendPercent: 0,
    changePercent: 0,
    realSellPrice: null,
    ...partial
  };
}

const signals = [
  signal({ itemId: 23424, name: "魔铁矿石", sellPrice: 5000, spreadPercent: 22 }),
  signal({ itemId: 22785, name: "梦叶草", sellPrice: 800, quantity: 2000 })
];

describe("evaluateAlertRules", () => {
  it("triggers gt/lt rules against the matching item's metric", () => {
    const triggered = evaluateAlertRules(
      [
        { id: "a", itemId: 23424, metric: "spreadPercent", operator: "gt", threshold: 15, enabled: true },
        { id: "b", itemId: 22785, metric: "quantity", operator: "gt", threshold: 1000, enabled: true },
        { id: "c", itemId: 23424, metric: "sellPrice", operator: "gt", threshold: 999999, enabled: true }
      ],
      signals
    );
    expect(triggered.map((hit) => hit.rule.id)).toEqual(["a", "b"]);
    expect(triggered[0].actual).toBe(22);
  });

  it("skips disabled rules and rules for unscanned items", () => {
    const triggered = evaluateAlertRules(
      [
        { id: "a", itemId: 23424, metric: "sellPrice", operator: "gt", threshold: 1, enabled: false },
        { id: "b", itemId: 99999, metric: "sellPrice", operator: "gt", threshold: 1, enabled: true }
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
    expect(goldDenominatedMetrics.has("sellPrice")).toBe(true);
    expect(goldDenominatedMetrics.has("sellRef")).toBe(true);
    expect(goldDenominatedMetrics.has("spreadPercent")).toBe(false);
    for (const key of goldDenominatedMetrics) expect(alertMetricKeys).toContain(key);
  });
});
