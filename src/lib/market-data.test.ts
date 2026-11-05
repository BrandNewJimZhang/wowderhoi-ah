import { describe, expect, it } from "vitest";
import { currentScanDemand } from "@/lib/market-data";

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
