import { describe, expect, it } from "vitest";
import { alphaDecay, evaluatePolicy, type LoggedDecision, type RealizedTrade } from "@/lib/off-policy";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date("2026-07-01T00:00:00Z");

describe("evaluatePolicy", () => {
  const decisions: LoggedDecision[] = [
    { id: "a", itemId: 1, kind: "buy", at: start },
    { id: "b", itemId: 2, kind: "buy", at: start }
  ];
  const trades: RealizedTrade[] = [
    { itemId: 1, pnl: 100, realizedAt: new Date(start.getTime() + DAY) },
    { itemId: 2, pnl: 50, realizedAt: new Date(start.getTime() + DAY) }
  ];

  it("matches trades to decisions and reports coverage", () => {
    const estimate = evaluatePolicy(decisions, trades, (decision) => decision.itemId === 1);
    expect(estimate.estimate).toBe(100);
    expect(estimate.matched).toBe(1);
    expect(estimate.coverage).toBeCloseTo(0.5, 5);
    expect(estimate.effectiveSampleSize).toBeCloseTo(1, 5);
  });

  it("attributes an adopted trade by identity even outside the window", () => {
    const estimate = evaluatePolicy(
      [{ ...decisions[0], decisionId: "d1" }],
      [{ itemId: 1, pnl: 100, realizedAt: new Date(start.getTime() + 30 * DAY), decisionId: "d1" }],
      () => true
    );
    expect(estimate.matched).toBe(1);
  });

  it("weights by the logged propensity and clips extreme weights", () => {
    const estimate = evaluatePolicy(
      [{ ...decisions[0], propensity: 0.1 }],
      trades,
      () => true,
      { maxWeight: 5 }
    );
    expect(estimate.estimate).toBe(100);
  });

  it("does not match a trade outside the window", () => {
    const estimate = evaluatePolicy(
      decisions,
      [{ itemId: 1, pnl: 100, realizedAt: new Date(start.getTime() + 30 * DAY) }],
      () => true,
      { windowDays: 7 }
    );
    expect(estimate.matched).toBe(0);
  });

  it("does not match a sale that was already listed before the decision", () => {
    const estimate = evaluatePolicy(
      decisions,
      [{
        itemId: 1,
        pnl: 100,
        realizedAt: new Date(start.getTime() + 2 * DAY),
        listedAt: new Date(start.getTime() - DAY),
        observedAt: new Date(start.getTime() + 2 * DAY)
      }],
      () => true,
      { windowDays: 7 }
    );
    expect(estimate.matched).toBe(0);
  });

  it("matches a sale listed inside the window even when the mailbox was opened later", () => {
    const estimate = evaluatePolicy(
      decisions,
      [{
        itemId: 1,
        pnl: 100,
        realizedAt: new Date(start.getTime() + 30 * DAY),
        listedAt: new Date(start.getTime() + DAY),
        observedAt: new Date(start.getTime() + 30 * DAY)
      }],
      () => true,
      { windowDays: 7 }
    );
    expect(estimate.matched).toBe(1);
  });
});

describe("alphaDecay", () => {
  const trade = (week: number, pnl: number): RealizedTrade => ({
    itemId: 1, pnl, realizedAt: new Date(start.getTime() + week * 7 * DAY + DAY)
  });

  it("flags a falling win rate across windows", () => {
    const report = alphaDecay([
      trade(0, 100), trade(0, 100),
      trade(1, 100), trade(1, -100),
      trade(2, -100), trade(2, -100)
    ]);
    expect(report.buckets).toHaveLength(3);
    expect(report.decaying).toBe(true);
    expect(report.reason).toContain("胜率");
  });

  it("does not flag a stable edge", () => {
    const report = alphaDecay([trade(0, 100), trade(1, 100), trade(2, 100)]);
    expect(report.decaying).toBe(false);
  });

  it("asks for more windows instead of guessing from two", () => {
    const report = alphaDecay([trade(0, 100), trade(1, -100)]);
    expect(report.decaying).toBe(false);
    expect(report.reason).toContain("窗口不足");
  });

  it("returns an empty report for no trades", () => {
    expect(alphaDecay([]).buckets).toEqual([]);
  });

  it("buckets a delayed inbox sale by the week it was listed", () => {
    const report = alphaDecay([
      {
        itemId: 1,
        pnl: 100,
        realizedAt: new Date(start.getTime() + 3 * 7 * DAY),
        listedAt: new Date(start.getTime() + DAY),
        observedAt: new Date(start.getTime() + 3 * 7 * DAY)
      },
      trade(1, 50)
    ]);
    expect(report.buckets).toHaveLength(2);
    expect(report.buckets[0].count).toBe(1);
    expect(report.buckets[0].pnl).toBe(100);
  });
});
