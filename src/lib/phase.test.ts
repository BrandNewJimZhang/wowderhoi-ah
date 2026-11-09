import { describe, expect, it } from "vitest";
import { historyWindowHours, nextPhaseBoundaryAt, phaseDescription, phaseLabels, resolvePhase } from "@/lib/phase";
import { phaseBoundaries, phaseHistory } from "@/lib/market-rules";

describe("resolvePhase", () => {
  it("uses breadth to keep a small market in ignition even when it is old", () => {
    expect(resolvePhase(100, phaseBoundaries.ignitionBreadth - 1)).toBe("ignition");
  });

  it("moves through wave, settle and steady as age and breadth grow", () => {
    expect(resolvePhase(1, 1000)).toBe("ignition");
    expect(resolvePhase(10, 1000)).toBe("wave");
    expect(resolvePhase(60, 1000)).toBe("settle");
    expect(resolvePhase(200, 1000)).toBe("steady");
  });

  it("never skips a phase because breadth is low", () => {
    expect(resolvePhase(200, 1)).toBe("ignition");
    expect(resolvePhase(200, phaseBoundaries.waveBreadth - 1)).toBe("wave");
    expect(resolvePhase(200, phaseBoundaries.settleBreadth - 1)).toBe("settle");
  });

  it("exposes the phase's history window", () => {
    expect(historyWindowHours("wave")).toBe(phaseHistory.wave.windowHours);
    expect(historyWindowHours("steady")).toBe(phaseHistory.steady.windowHours);
  });

  it("borrows the steady window where a phase has none", () => {
    // Ignition has no history by design; the trend statistic must still
    // read the window from the rule table, not a second literal.
    expect(phaseHistory.ignition.windowHours).toBe(0);
    expect(historyWindowHours("ignition")).toBe(phaseHistory.steady.windowHours);
  });

  it("has a label and a strategy note for every phase", () => {
    for (const phase of ["ignition", "wave", "settle", "steady"] as const) {
      expect(phaseLabels[phase]).toBeTruthy();
      expect(phaseDescription(phase)).toBeTruthy();
    }
  });
});

describe("nextPhaseBoundaryAt", () => {
  const anchor = new Date("2026-01-01T00:00:00Z");
  const hoursLater = (hours: number) => new Date(anchor.getTime() + hours * 3_600_000);
  const cases = [
    { breadth: phaseBoundaries.ignitionBreadth - 1, now: 0, boundary: null },
    { breadth: phaseBoundaries.ignitionBreadth, now: 0, boundary: 6 },
    { breadth: phaseBoundaries.ignitionBreadth, now: 6, boundary: null },
    { breadth: phaseBoundaries.waveBreadth - 1, now: 0, boundary: 6 },
    { breadth: phaseBoundaries.waveBreadth - 1, now: 6, boundary: null },
    { breadth: phaseBoundaries.waveBreadth, now: 0, boundary: 6 },
    { breadth: phaseBoundaries.waveBreadth, now: 6, boundary: 48 },
    { breadth: phaseBoundaries.waveBreadth, now: 48, boundary: null },
    { breadth: phaseBoundaries.settleBreadth, now: 0, boundary: 6 },
    { breadth: phaseBoundaries.settleBreadth, now: 6, boundary: 48 },
    { breadth: phaseBoundaries.settleBreadth, now: 48, boundary: 168 },
    { breadth: phaseBoundaries.settleBreadth, now: 168, boundary: null }
  ] as const;

  it("names the next moment resolvePhase changes, and nothing after the last boundary", () => {
    for (const entry of cases) {
      const at = nextPhaseBoundaryAt(anchor, entry.breadth, hoursLater(entry.now));
      expect(at, `breadth ${entry.breadth} at ${entry.now}h`).toEqual(
        entry.boundary === null ? null : hoursLater(entry.boundary)
      );
    }
  });

  it("agrees with resolvePhase on both sides of every boundary", () => {
    for (const entry of cases) {
      if (entry.boundary === null) continue;
      const before = resolvePhase(entry.boundary - 0.001, entry.breadth);
      const at = resolvePhase(entry.boundary, entry.breadth);
      expect(at, `breadth ${entry.breadth} at ${entry.boundary}h`).not.toBe(before);
    }
  });

  it("never schedules a boundary without an anchor", () => {
    // ageHours treats a missing anchor as zero, so the phase cannot advance.
    expect(nextPhaseBoundaryAt(null, phaseBoundaries.settleBreadth, anchor)).toBeNull();
  });
});
