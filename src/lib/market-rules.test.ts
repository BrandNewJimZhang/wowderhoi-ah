import { describe, expect, it } from "vitest";
import {
  AH_FEE_RATE,
  marketPhases,
  marketTypeRules,
  phaseBoundaries,
  phaseHistory,
  portfolioRules,
  sellFrontRules,
  type MarketType
} from "@/lib/market-rules";

const marketTypes: readonly MarketType[] = ["vendor", "commodity", "item"];

describe("phase rules", () => {
  it("defines every market type in every phase", () => {
    for (const phase of marketPhases) {
      for (const type of marketTypes) {
        expect(marketTypeRules[phase][type], `${phase}/${type}`).toBeDefined();
      }
    }
  });

  it("orders phase boundaries smallest to largest", () => {
    const { ignitionHours, waveHours, settleHours } = phaseBoundaries;
    expect(ignitionHours).toBeLessThan(waveHours);
    expect(waveHours).toBeLessThan(settleHours);
    const { ignitionBreadth, waveBreadth, settleBreadth } = phaseBoundaries;
    expect(ignitionBreadth).toBeLessThan(waveBreadth);
    expect(waveBreadth).toBeLessThan(settleBreadth);
  });

  it("asks for more history and more samples as the market matures", () => {
    for (let index = 1; index < marketPhases.length; index += 1) {
      const previous = phaseHistory[marketPhases[index - 1]];
      const current = phaseHistory[marketPhases[index]];
      expect(current.windowHours).toBeGreaterThanOrEqual(previous.windowHours);
      expect(current.minSamples).toBeGreaterThanOrEqual(previous.minSamples);
    }
  });

  // Early phases demand a wider spread because the reference price is
  // barely credible; later phases can act on a smaller, better-measured
  // edge. The net floor rises throughout because competition arrives.
  it("narrows the accepted spread band and raises the net floor over time", () => {
    for (const type of ["commodity", "item"] as const) {
      for (let index = 1; index < marketPhases.length; index += 1) {
        const previous = marketTypeRules[marketPhases[index - 1]][type];
        const current = marketTypeRules[marketPhases[index]][type];
        expect(current.minSpread, `${type} minSpread`).toBeLessThan(previous.minSpread);
        expect(current.maxSpread, `${type} maxSpread`).toBeLessThan(previous.maxSpread);
        expect(current.minNet, `${type} minNet`).toBeGreaterThan(previous.minNet);
        expect(current.minListings, `${type} minListings`).toBeGreaterThanOrEqual(previous.minListings);
      }
    }
  });

  it("keeps vendor arbitrage free of market-risk floors in every phase", () => {
    for (const phase of marketPhases) {
      const vendor = marketTypeRules[phase].vendor;
      expect(vendor.minSpread).toBe(0);
      expect(vendor.maxSpread).toBe(1);
      expect(vendor.minNet).toBe(0);
      expect(vendor.minUnitProfit).toBe(0);
    }
  });
});

describe("pricing constants", () => {
  it("uses a plausible auction cut and undercut", () => {
    expect(AH_FEE_RATE).toBeGreaterThan(0);
    expect(AH_FEE_RATE).toBeLessThan(0.2);
    expect(sellFrontRules.alpha).toBeGreaterThan(0);
    expect(sellFrontRules.alpha).toBeLessThan(1);
    expect(sellFrontRules.undercutCopper).toBe(1);
    expect(sellFrontRules.undercutWarnRatio).toBeGreaterThan(0);
    expect(sellFrontRules.undercutWarnRatio).toBeLessThan(0.1);
    expect(sellFrontRules.noiseMultiple).toBeGreaterThan(1);
  });

  it("keeps position limits fractional and bounded", () => {
    expect(portfolioRules.kellyFraction).toBeGreaterThan(0);
    expect(portfolioRules.kellyFraction).toBeLessThanOrEqual(1);
    expect(portfolioRules.maxItemExposure).toBeLessThanOrEqual(1);
    expect(portfolioRules.dailyBudget).toBeLessThanOrEqual(1);
  });
});
