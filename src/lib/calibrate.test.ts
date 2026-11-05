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
    sellersInvisible: false,
    ...overrides
  };
}

function scope(overrides: Partial<Parameters<typeof calibrationObservations>[1]> = {}) {
  return {
    scanMinutes: 15,
    marketOpenedAt: at(-800 * 60),
    breadthByScan: new Map<number, number>(),
    marketFirstScanAt: at(0),
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
      scope({ breadthByScan: new Map([[at(15).getTime(), 900]]) })
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
      scope({ marketOpenedAt: null })
    );
    expect(observations).toHaveLength(0);
  });

  it("never learns from a scan that had no previous capture to diff", () => {
    // The first scan after an upgrade, or an item that was just listed,
    // reports zeros because there was no baseline -- not because nothing
    // sold. A whole market of such zeros would teach the prior to be zero.
    // Rows imported before the flag existed carry undefined and stay usable.
    const observations = calibrationObservations(
      [
        row({ itemId: 1, timestamp: at(0) }),
        row({ itemId: 1, timestamp: at(15), soldLow: 10 }),
        row({ itemId: 2, timestamp: at(0), flowObserved: false }),
        row({ itemId: 2, timestamp: at(15), flowObserved: false }),
        row({ itemId: 3, timestamp: at(0) }),
        row({ itemId: 3, timestamp: at(15), soldLow: 4 })
      ],
      scope({ marketOpenedAt: null })
    );
    expect(observations.map((observation) => observation.itemId).sort()).toEqual([1, 3]);
  });

  it("never learns from a book whose owners were hidden", () => {
    // A hidden-owner book reports a zero lower edge by construction. Feeding
    // that into the prior would teach the model that nothing ever sells.
    const observations = calibrationObservations(
      [
        row({ itemId: 1, timestamp: at(0), sellersInvisible: true }),
        row({ itemId: 1, timestamp: at(15), sellersInvisible: true })
      ],
      scope({ marketOpenedAt: null })
    );
    expect(observations).toHaveLength(0);
  });

  it("skips gaps that are paused scans rather than rates", () => {
    const observations = calibrationObservations(
      [row({ itemId: 1, timestamp: at(0) }), row({ itemId: 1, timestamp: at(180), soldLow: 10 })],
      scope({ marketOpenedAt: null })
    );
    expect(observations).toHaveLength(0);
  });

  it("labels an item that appeared late by the market's age and breadth", () => {
    // The item's own history starts at minute 1000 (~17h) with all its rows
    // a quarter hour apart; a per-item age would call that ignition, while
    // the market itself is 17h old with 900 kinds listed -- wave.
    const observations = calibrationObservations(
      [
        row({ itemId: 9, timestamp: at(1000) }),
        row({ itemId: 9, timestamp: at(1015), soldLow: 5 })
      ],
      scope({
        marketOpenedAt: null,
        marketFirstScanAt: at(0),
        breadthByScan: new Map([
          [at(1000).getTime(), 900],
          [at(1015).getTime(), 900]
        ])
      })
    );
    expect(observations).toHaveLength(1);
    expect(observations[0].phase).toBe("wave");
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
