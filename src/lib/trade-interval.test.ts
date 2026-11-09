import { describe, expect, it } from "vitest";
import { overlapsWindow, startsWithinWindow, tradeInterval } from "@/lib/trade-interval";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date("2026-07-01T00:00:00Z");

describe("tradeInterval", () => {
  it("spans the listing and the observation when both are known", () => {
    const interval = tradeInterval({
      realizedAt: new Date(start.getTime() + 3 * DAY),
      listedAt: start,
      observedAt: new Date(start.getTime() + 3 * DAY)
    });
    expect(interval).toEqual({ low: start.getTime(), high: start.getTime() + 3 * DAY });
  });

  it("falls back to the observation point for legacy rows", () => {
    const interval = tradeInterval({ realizedAt: start });
    expect(interval).toEqual({ low: start.getTime(), high: start.getTime() });
  });

  it("collapses a malformed interval onto the observation point", () => {
    const interval = tradeInterval({
      realizedAt: start,
      listedAt: new Date(start.getTime() + DAY),
      observedAt: new Date(start.getTime() - DAY)
    });
    expect(interval).toEqual({ low: start.getTime(), high: start.getTime() });
  });
});

describe("overlapsWindow", () => {
  it("matches a sale listed inside the window even when the mailbox was opened later", () => {
    const trade = {
      realizedAt: new Date(start.getTime() + 10 * DAY),
      listedAt: new Date(start.getTime() + DAY),
      observedAt: new Date(start.getTime() + 10 * DAY)
    };
    expect(overlapsWindow(trade, start.getTime(), start.getTime() + 7 * DAY)).toBe(true);
  });

  it("does not match a sale listed after the window", () => {
    const trade = {
      realizedAt: new Date(start.getTime() + 20 * DAY),
      listedAt: new Date(start.getTime() + 10 * DAY),
      observedAt: new Date(start.getTime() + 20 * DAY)
    };
    expect(overlapsWindow(trade, start.getTime(), start.getTime() + 7 * DAY)).toBe(false);
  });
});

describe("startsWithinWindow", () => {
  const windowEnd = start.getTime() + 7 * DAY;

  it("requires the listing, not the mailbox report, to fall inside the window", () => {
    const trade = {
      realizedAt: new Date(start.getTime() + 30 * DAY),
      listedAt: new Date(start.getTime() + DAY),
      observedAt: new Date(start.getTime() + 30 * DAY)
    };
    expect(startsWithinWindow(trade, start.getTime(), windowEnd)).toBe(true);
  });

  it("rejects a sale that was already listed before the decision", () => {
    const trade = {
      realizedAt: new Date(start.getTime() + 2 * DAY),
      listedAt: new Date(start.getTime() - DAY),
      observedAt: new Date(start.getTime() + 2 * DAY)
    };
    expect(startsWithinWindow(trade, start.getTime(), windowEnd)).toBe(false);
  });
});
