import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBudgetCopper, resolveDeployableCopper, resolvePhaseOverride } from "@/lib/config";
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

describe("resolveDeployableCopper", () => {
  it("caps the plan at the scanned purse", () => {
    vi.stubEnv("AQT_BUDGET_COPPER", "500000");
    expect(resolveDeployableCopper(120000)).toBe(120000);
  });

  it("never exceeds the planning budget", () => {
    vi.stubEnv("AQT_BUDGET_COPPER", "500000");
    expect(resolveDeployableCopper(900000)).toBe(500000);
  });

  it("uses the whole budget when the balance is unknown", () => {
    vi.stubEnv("AQT_BUDGET_COPPER", "500000");
    expect(resolveDeployableCopper(null)).toBe(500000);
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
