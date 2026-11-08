import { describe, expect, it } from "vitest";
import { bucketPredictions } from "@/lib/decision-calibration";
import { fillRules } from "@/lib/market-rules";

const base = new Date("2026-11-01T00:00:00Z");
const at = (hours: number) => new Date(base.getTime() + hours * 60 * 60 * 1000);

const buy = (options: { itemId?: number; at: Date; fillProb: number; fillBasis?: string }) => ({
  itemId: options.itemId ?? 1,
  kind: "buy",
  at: options.at,
  fillProb: options.fillProb,
  fillBasis: options.fillBasis ?? "proxy"
});

const sale = (options: { itemId?: number; at: Date; inferred?: boolean; channel?: string }) => ({
  itemId: options.itemId ?? 1,
  realizedAt: options.at,
  inferred: options.inferred ?? false,
  channel: options.channel ?? "auction"
});

describe("decision calibration", () => {
  it("counts a decision as filled only inside the predicted horizon", () => {
    const buckets = bucketPredictions(
      [buy({ at: at(0), fillProb: 0.3 })],
      [sale({ at: at(10) }), sale({ itemId: 2, at: at(10) })]
    );
    const bucket = buckets.find((entry) => entry.label === "20–40%")!;
    expect(bucket.decisions).toBe(1);
    expect(bucket.filled).toBe(1);
    // The prediction is a fill chance within the rule's horizon; a sale one
    // hour past it is not evidence that the prediction was right.
    const late = bucketPredictions(
      [buy({ at: at(0), fillProb: 0.3 })],
      [sale({ at: at(fillRules.horizonHours + 1) })]
    ).find((entry) => entry.label === "20–40%")!;
    expect(late.filled).toBe(0);
  });

  it("ignores inferred sales, sell decisions and vendor sales", () => {
    const buckets = bucketPredictions(
      [
        buy({ at: at(0), fillProb: 0.1 }),
        { itemId: 1, kind: "sell", at: at(0), fillProb: 0.1, fillBasis: null }
      ],
      [
        sale({ at: at(1), inferred: true }),
        sale({ at: at(2), channel: "vendor" })
      ]
    );
    const bucket = buckets.find((entry) => entry.label === "0–20%")!;
    expect(bucket.decisions).toBe(1);
    // A vendor sale is not an auction fill; counting it would inflate the
    // measured fill rate for a prediction about the auction book.
    expect(bucket.filled).toBe(0);
  });

  it("leaves vendor guarantees out of the fill calibration", () => {
    // A vendor-arbitrage buy has a guaranteed exit, so its fillProb is 1 by
    // construction. It calibrates nothing about auction fill rates.
    const buckets = bucketPredictions(
      [buy({ at: at(0), fillProb: 1, fillBasis: "vendor" })],
      [sale({ at: at(1), channel: "vendor" })]
    );
    const bucket = buckets.find((entry) => entry.label === "80–100%")!;
    expect(bucket.decisions).toBe(0);
    expect(bucket.filled).toBe(0);
  });

  it("attributes an adopted sale by identity and a legacy one by window", () => {
    const adopted = bucketPredictions(
      [{ ...buy({ at: at(0), fillProb: 0.3 }), decisionId: "d1" }],
      [{ ...sale({ at: at(10) }), decisionId: "d1" }]
    ).find((entry) => entry.label === "20–40%")!;
    expect(adopted.filled).toBe(1);
    expect(adopted.linked).toBe(1);
    expect(adopted.window).toBe(0);

    const legacy = bucketPredictions(
      [buy({ at: at(0), fillProb: 0.3 })],
      [sale({ at: at(10) })]
    ).find((entry) => entry.label === "20–40%")!;
    expect(legacy.filled).toBe(1);
    expect(legacy.linked).toBe(0);
    expect(legacy.window).toBe(1);
  });

  it("does not let an identity match outlive the prediction horizon", () => {
    const late = bucketPredictions(
      [{ ...buy({ at: at(0), fillProb: 0.3 }), decisionId: "d1" }],
      [{ ...sale({ at: at(fillRules.horizonHours + 1) }), decisionId: "d1" }]
    ).find((entry) => entry.label === "20–40%")!;
    expect(late.filled).toBe(0);
    expect(late.linked).toBe(0);
    expect(late.window).toBe(0);
  });

  it("marks buckets below the sample floor as insufficient", () => {
    const decisions = Array.from({ length: 10 }, (_, index) => buy({ at: at(index), fillProb: 0.9 }));
    const buckets = bucketPredictions(decisions, []);
    const bucket = buckets.find((entry) => entry.label === "80–100%")!;
    expect(bucket.decisions).toBe(10);
    expect(bucket.enoughSamples).toBe(true);
    expect(buckets.find((entry) => entry.label === "0–20%")!.enoughSamples).toBe(false);
  });
});
