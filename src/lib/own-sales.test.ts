import { describe, expect, it } from "vitest";
import { ownSalesFromRows } from "@/lib/own-sales";
import { SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";

const NOW = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe("ownSalesFromRows", () => {
  it("counts sales inside the window ending at the reference time", () => {
    const sales = ownSalesFromRows([
      { itemId: 1, qty: 3, realizedAt: hoursAgo(2), listedAt: hoursAgo(4) }
    ], NOW);
    expect(sales[1]).toEqual({ qty: 3, samples: 1, exposedHours: 2 });
  });

  it("ignores a sale realized after the reference time", () => {
    // A replayed scan is evaluated at its own timestamp: a sale booked later
    // is not evidence the core had when it made that recommendation.
    const sales = ownSalesFromRows([
      { itemId: 1, qty: 3, realizedAt: hoursAgo(-1), listedAt: hoursAgo(-3) }
    ], NOW);
    expect(sales[1]).toBeUndefined();
  });

  it("ignores sales older than the observation window", () => {
    const sales = ownSalesFromRows([
      { itemId: 1, qty: 3, realizedAt: hoursAgo(24 * 30), listedAt: hoursAgo(24 * 30 + 2) }
    ], NOW);
    expect(sales[1]).toBeUndefined();
  });

  it("floors exposure at one scan interval when the listing time is missing", () => {
    const sales = ownSalesFromRows([
      { itemId: 1, qty: 1, realizedAt: hoursAgo(1), listedAt: null }
    ], NOW);
    expect(sales[1].exposedHours).toBe(SCAN_INTERVAL_MINUTES / 60);
  });
});
