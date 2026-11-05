import { describe, expect, it } from "vitest";
import { bucketPredictions } from "@/lib/decision-calibration";

const base = new Date("2026-11-01T00:00:00Z");
const at = (hours: number) => new Date(base.getTime() + hours * 60 * 60 * 1000);

describe("decision calibration", () => {
  it("counts a decision as filled only inside its window", () => {
    const buckets = bucketPredictions(
      [{ itemId: 1, kind: "buy", at: at(0), fillProb: 0.3 }],
      [
        { itemId: 1, realizedAt: at(10), inferred: false },
        { itemId: 2, realizedAt: at(10), inferred: false }
      ]
    );
    const bucket = buckets.find((entry) => entry.label === "20–40%")!;
    expect(bucket.decisions).toBe(1);
    expect(bucket.filled).toBe(1);
    const late = bucketPredictions(
      [{ itemId: 1, kind: "buy", at: at(0), fillProb: 0.3 }],
      [{ itemId: 1, realizedAt: at(100), inferred: false }]
    ).find((entry) => entry.label === "20–40%")!;
    expect(late.filled).toBe(0);
  });

  it("ignores inferred sales and sell decisions", () => {
    const buckets = bucketPredictions(
      [
        { itemId: 1, kind: "buy", at: at(0), fillProb: 0.1 },
        { itemId: 1, kind: "sell", at: at(0), fillProb: 0.1 }
      ],
      [{ itemId: 1, realizedAt: at(1), inferred: true }]
    );
    const bucket = buckets.find((entry) => entry.label === "0–20%")!;
    expect(bucket.decisions).toBe(1);
    expect(bucket.filled).toBe(0);
  });

  it("marks buckets below the sample floor as insufficient", () => {
    const decisions = Array.from({ length: 10 }, (_, index) => ({
      itemId: 1,
      kind: "buy",
      at: at(index),
      fillProb: 0.9
    }));
    const buckets = bucketPredictions(decisions, []);
    const bucket = buckets.find((entry) => entry.label === "80–100%")!;
    expect(bucket.decisions).toBe(10);
    expect(bucket.enoughSamples).toBe(true);
    expect(buckets.find((entry) => entry.label === "0–20%")!.enoughSamples).toBe(false);
  });
});
