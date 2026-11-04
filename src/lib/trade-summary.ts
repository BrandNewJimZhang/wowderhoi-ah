// Realized P&L splits by evidence. A confirmed sale is a journal `sold`
// event (or a collected fill); an inferred sale is a listing that vanished
// without an expiry event and was booked at its posted price. Inferred rows
// stay in the ledger and stay labelled, but they are guesses: counting them
// as realized cash or as calibration labels overstates both the P&L and the
// quality of the evidence.
export type TradeLike = { pnl: number; fee: number; inferred: boolean };

export type TradeSummary = {
  confirmedRealized: number;
  inferredRealized: number;
  confirmedFees: number;
  confirmedCount: number;
  inferredCount: number;
  confirmedWins: number;
};

export function summarizeTrades(trades: readonly TradeLike[]): TradeSummary {
  const summary: TradeSummary = {
    confirmedRealized: 0,
    inferredRealized: 0,
    confirmedFees: 0,
    confirmedCount: 0,
    inferredCount: 0,
    confirmedWins: 0
  };
  for (const trade of trades) {
    if (trade.inferred) {
      summary.inferredCount += 1;
      summary.inferredRealized += trade.pnl;
    } else {
      summary.confirmedCount += 1;
      summary.confirmedRealized += trade.pnl;
      summary.confirmedFees += trade.fee;
      if (trade.pnl > 0) summary.confirmedWins += 1;
    }
  }
  return summary;
}
