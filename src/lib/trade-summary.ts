// Realized P&L splits by evidence. A confirmed sale is a journal `sold`
// event (or a collected fill); an inferred sale is a listing that vanished
// without an expiry event and was booked at its posted price. Inferred rows
// stay in the ledger and stay labelled, but they are guesses: counting them
// as realized cash or as calibration labels overstates both the P&L and the
// quality of the evidence.
type TradeLike = {
  pnl: number;
  fee: number;
  inferred: boolean;
  // Absent on rows written before the ledger tracked basis provenance;
  // those were booked by construction and count as known.
  basisKnown?: boolean;
};

// One label per sale channel. The portfolio table printed the raw journal
// identifier ("auction"/"vendor") while the review page translated it, so
// the same trade read as two different things on two pages.
const TRADE_CHANNEL_LABELS: Record<string, string> = {
  auction: "拍卖行",
  vendor: "卖店"
};

export function tradeChannelLabel(channel: string): string {
  return TRADE_CHANNEL_LABELS[channel] ?? channel;
}

type TradeSummary = {
  confirmedRealized: number;
  // A sale whose consumed units had no booked cost proves revenue, not
  // profit. It stays out of the realized total and the win rate, and the
  // UI reports it as a separate count so the omission is visible.
  unknownBasisRealized: number;
  unknownBasisCount: number;
  inferredRealized: number;
  confirmedFees: number;
  confirmedCount: number;
  inferredCount: number;
  confirmedWins: number;
};

export function summarizeTrades(trades: readonly TradeLike[]): TradeSummary {
  const summary: TradeSummary = {
    confirmedRealized: 0,
    unknownBasisRealized: 0,
    unknownBasisCount: 0,
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
      continue;
    }
    summary.confirmedCount += 1;
    // The fee is a fact whichever basis the goods carried.
    summary.confirmedFees += trade.fee;
    if (trade.basisKnown === false) {
      summary.unknownBasisCount += 1;
      summary.unknownBasisRealized += trade.pnl;
      continue;
    }
    summary.confirmedRealized += trade.pnl;
    if (trade.pnl > 0) summary.confirmedWins += 1;
  }
  return summary;
}
