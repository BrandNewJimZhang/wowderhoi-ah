import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBudgetCopper, resolvePhaseOverride } from "@/lib/config";
import { DEFAULT_BUDGET_COPPER } from "@/lib/market-rules";

afterEach(() => vi.unstubAllEnvs());

describe("resolveBudgetCopper", () => {
  it("uses a positive configured budget", () => {
    vi.stubEnv("AQT_BUDGET_COPPER", "250000");
    expect(resolveBudgetCopper()).toBe(250000);
  });

  it("rejects zero, negative, empty and non-numeric values", () => {
    for (const value of ["0", "-5", "", "abc"]) {
      vi.stubEnv("AQT_BUDGET_COPPER", value);
      expect(resolveBudgetCopper(), value).toBe(DEFAULT_BUDGET_COPPER);
    }
  });

  it("falls back when the variable is unset", () => {
    vi.stubEnv("AQT_BUDGET_COPPER", undefined);
    expect(resolveBudgetCopper()).toBe(DEFAULT_BUDGET_COPPER);
  });
});

describe("resolvePhaseOverride", () => {
  it("returns a known phase", () => {
    vi.stubEnv("AQT_PHASE", "wave");
    expect(resolvePhaseOverride()).toBe("wave");
  });

  it("ignores an unknown or empty phase instead of evaluating under it", () => {
    vi.stubEnv("AQT_PHASE", "launch");
    expect(resolvePhaseOverride()).toBeNull();
    vi.stubEnv("AQT_PHASE", "");
    expect(resolvePhaseOverride()).toBeNull();
  });
});
