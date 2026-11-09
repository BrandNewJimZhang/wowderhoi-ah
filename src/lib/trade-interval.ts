// A sale is not observed when it happens. An auction fill reaches the
// terminal only when the mailbox is opened, which can be days later, so the
// only honest time for a booked trade is the interval [listedAt, observedAt].
// Every consumer that asks "was this sale inside that window?" must use the
// interval; a point comparison makes a lazy inbox sweep look like a late or
// failed prediction.
export type TradeTimeBounds = {
  realizedAt: Date;
  listedAt?: Date | null;
  observedAt?: Date | null;
};

export function tradeInterval(trade: TradeTimeBounds): { low: number; high: number } {
  const realized = trade.realizedAt.getTime();
  const low = (trade.listedAt ?? trade.realizedAt).getTime();
  const high = (trade.observedAt ?? trade.realizedAt).getTime();
  // A malformed interval still contains its observation point.
  return high >= low ? { low, high } : { low: realized, high: realized };
}

export function overlapsWindow(trade: TradeTimeBounds, start: number, end: number): boolean {
  const interval = tradeInterval(trade);
  return interval.high >= start && interval.low <= end;
}

// Attribution asks a narrower question than calibration: was the sale
// produced by this decision? The goods must have been listed after the
// decision was made; only the observation is allowed to land later.
export function startsWithinWindow(trade: TradeTimeBounds, start: number, end: number): boolean {
  const { low } = tradeInterval(trade);
  return low >= start && low <= end;
}
