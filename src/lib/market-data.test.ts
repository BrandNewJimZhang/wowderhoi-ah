import { describe, expect, it } from "vitest";
import { currentScanDemand, priceObservationAt, sellPriceOf } from "@/lib/market-data";

const at = (iso: string) => ({ timestamp: new Date(iso) });

describe("currentScanDemand", () => {
  it("returns the demand row captured with the newest scan", () => {
    const row = at("2026-11-05T10:00:00.000Z");
    expect(currentScanDemand(row, new Date("2026-11-05T10:00:00.000Z"))).toBe(row);
  });

  it("drops a demand row from an older scan", () => {
    const row = at("2026-11-05T09:45:00.000Z");
    expect(currentScanDemand(row, new Date("2026-11-05T10:00:00.000Z"))).toBeNull();
  });

  it("returns null when there is no demand row or no scan", () => {
    expect(currentScanDemand(null, new Date("2026-11-05T10:00:00.000Z"))).toBeNull();
    expect(currentScanDemand(undefined, new Date("2026-11-05T10:00:00.000Z"))).toBeNull();
    expect(currentScanDemand(at("2026-11-05T10:00:00.000Z"), null)).toBeNull();
  });
});

describe("priceObservationAt", () => {
  const scan = new Date("2026-11-05T10:00:00.000Z");

  it("dates the price by the last series point, not the demand quote", () => {
    const series = [{ t: Math.round(scan.getTime() / 1000) - 3600 }];
    expect(priceObservationAt(series, { timestamp: scan }, scan)).toEqual(new Date(scan.getTime() - 3600 * 1000));
  });

  it("clamps a series point later than the newest generation", () => {
    const series = [{ t: Math.round(scan.getTime() / 1000) + 3600 }];
    expect(priceObservationAt(series, null, scan)).toEqual(scan);
  });

  it("falls back to the quote when no series point exists", () => {
    expect(priceObservationAt([], { timestamp: scan }, scan)).toEqual(scan);
  });

  it("returns null when nothing was priced", () => {
    expect(priceObservationAt([], null, scan)).toBeNull();
  });
});

describe("sellPriceOf", () => {
  it("prefers the sell front", () => {
    expect(sellPriceOf({ sellPrice: 120, marketPrice: 100 })).toBe(120);
  });

  it("falls back to P10 for rows imported before the sell front existed", () => {
    // Those rows carry 0, not undefined: `??` would have kept the zero and
    // erased the price for every legacy chart and index observation.
    expect(sellPriceOf({ sellPrice: 0, marketPrice: 100 })).toBe(100);
    expect(sellPriceOf({ marketPrice: 100 })).toBe(100);
  });
});
