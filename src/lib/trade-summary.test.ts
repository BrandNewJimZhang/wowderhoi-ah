import { describe, expect, it } from "vitest";
import { summarizeTrades } from "@/lib/trade-summary";

describe("summarizeTrades", () => {
  it("keeps inferred sales out of realized P&L and win rate", () => {
    const summary = summarizeTrades([
      { pnl: 1200, fee: 100, inferred: false },
      { pnl: -300, fee: 40, inferred: false },
      { pnl: 9000, fee: 500, inferred: true }
    ]);
    expect(summary.confirmedRealized).toBe(900);
    expect(summary.confirmedFees).toBe(140);
    expect(summary.confirmedCount).toBe(2);
    expect(summary.confirmedWins).toBe(1);
    expect(summary.inferredRealized).toBe(9000);
    expect(summary.inferredCount).toBe(1);
  });

  it("returns zeroes for an empty ledger", () => {
    expect(summarizeTrades([])).toEqual({
      confirmedRealized: 0,
      inferredRealized: 0,
      confirmedFees: 0,
      confirmedCount: 0,
      inferredCount: 0,
      confirmedWins: 0
    });
  });
});
