import { describe, expect, it } from "vitest";
import { phaseDescription, phaseLabels, phaseWindowHours, resolvePhase } from "@/lib/phase";
import { phaseBoundaries } from "@/lib/market-rules";

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
    expect(phaseWindowHours("wave")).toBe(6);
    expect(phaseWindowHours("steady")).toBe(168);
  });

  it("has a label and a strategy note for every phase", () => {
    for (const phase of ["ignition", "wave", "settle", "steady"] as const) {
      expect(phaseLabels[phase]).toBeTruthy();
      expect(phaseDescription(phase)).toBeTruthy();
    }
  });
});
