import { describe, expect, it } from "vitest";
import { calibrationObservations, formatCalibration, summarizeCalibration, type CalibrationRow } from "@/lib/calibrate";

const start = new Date("2026-11-01T00:00:00Z");
const at = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000);

function row(overrides: Partial<CalibrationRow> & { itemId: number; timestamp: Date }): CalibrationRow {
  return {
    marketType: "commodity",
    supply: 100,
    soldLow: 0,
    observationVersion: 2,
    priced: true,
    ...overrides
  };
}

describe("fill-prior calibration", () => {
  it("uses adjacent scans a plausible gap apart", () => {
    const observations = calibrationObservations(
      [
        row({ itemId: 1, timestamp: at(0), supply: 100 }),
        row({ itemId: 1, timestamp: at(15), supply: 100, soldLow: 10 })
      ],
      { scanMinutes: 15, breadth: 900, marketOpenedAt: at(-800 * 60) }
    );
    expect(observations).toHaveLength(1);
    // 10 units over 100 supply in a quarter hour.
    expect(observations[0].hazard).toBeCloseTo(0.4, 5);
    expect(observations[0].phase).toBe("steady");
  });

  it("rejects rows from the pre-hygiene pipeline", () => {
    const observations = calibrationObservations(
      [
        row({ itemId: 1, timestamp: at(0) }),
        row({ itemId: 1, timestamp: at(15), soldLow: 10, observationVersion: 1 }),
        row({ itemId: 1, timestamp: at(30), soldLow: 12, observationVersion: null })
      ],
      { scanMinutes: 15, breadth: 900, marketOpenedAt: null }
    );
    expect(observations).toHaveLength(0);
  });

  it("skips gaps that are paused scans rather than rates", () => {
    const observations = calibrationObservations(
      [row({ itemId: 1, timestamp: at(0) }), row({ itemId: 1, timestamp: at(180), soldLow: 10 })],
      { scanMinutes: 15, breadth: 900, marketOpenedAt: null }
    );
    expect(observations).toHaveLength(0);
  });

  it("summarizes per phase and market type with quantiles", () => {
    const observations = [
      ...Array.from({ length: 5 }, () => ({ itemId: 1, marketType: "commodity" as const, phase: "steady" as const, hazard: 0.01 })),
      { itemId: 2, marketType: "commodity" as const, phase: "steady" as const, hazard: 0.03 },
      { itemId: 3, marketType: "item" as const, phase: "steady" as const, hazard: 0.005 }
    ];
    const buckets = summarizeCalibration(observations);
    const commodity = buckets.find((bucket) => bucket.phase === "steady" && bucket.marketType === "commodity")!;
    expect(commodity.samples).toBe(6);
    expect(commodity.medianHazard).toBeCloseTo(0.01, 6);
    expect(commodity.p75).toBeCloseTo(0.01, 6);
    const lines = formatCalibration(buckets);
    expect(lines.some((line) => line.includes("样本不足"))).toBe(true);
  });
});
