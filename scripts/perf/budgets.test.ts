import { describe, expect, it } from "vitest";
import { evaluateGate, gateBudgets, percentile, type PerfReport } from "./budgets";

function passingReport(): PerfReport {
  return {
    label: "test",
    scale: { itemsX: 1, depthX: 1 },
    homepage: { p50Ms: 200, p95Ms: 400, bytes: 100_000, failures: 0 },
    itemPages: { p50Ms: 50, p95Ms: 120, failures: 0 },
    importMs: 1500,
    postImportRebuildMs: 2500,
    contentionMaxStallMs: 600
  };
}

describe("percentile", () => {
  it("returns the value at the requested rank over unsorted input", () => {
    expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
    expect(percentile([50, 10, 40, 20, 30], 0.95)).toBe(50);
  });

  it("handles a single sample", () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("throws on empty input instead of fabricating a number", () => {
    expect(() => percentile([], 0.5)).toThrow(/empty/);
  });
});

describe("evaluateGate", () => {
  it("passes a report inside every budget", () => {
    const verdict = evaluateGate(passingReport());
    expect(verdict.pass).toBe(true);
    expect(verdict.breaches).toEqual([]);
  });

  it("flags every exceeded budget with the measured value", () => {
    const report = passingReport();
    report.homepage.p95Ms = gateBudgets.homepageP95Ms + 1;
    report.homepage.bytes = gateBudgets.homepageBytes + 1;
    report.itemPages.p95Ms = gateBudgets.itemPageP95Ms + 1;
    report.importMs = gateBudgets.importMs + 1;
    report.postImportRebuildMs = gateBudgets.postImportRebuildMs + 1;
    report.contentionMaxStallMs = gateBudgets.contentionStallMs + 1;
    const verdict = evaluateGate(report);
    expect(verdict.pass).toBe(false);
    expect(verdict.breaches).toHaveLength(6);
    expect(verdict.breaches.join("\n")).toMatch(/homepage p95/);
  });

  it("treats any failed request as a breach", () => {
    const report = passingReport();
    report.itemPages.failures = 2;
    const verdict = evaluateGate(report);
    expect(verdict.pass).toBe(false);
    expect(verdict.breaches.join("\n")).toMatch(/failed/);
  });

  it("ignores absent optional stages", () => {
    const report = passingReport();
    report.importMs = null;
    report.postImportRebuildMs = null;
    report.contentionMaxStallMs = null;
    expect(evaluateGate(report).pass).toBe(true);
  });
});
