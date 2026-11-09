// Compares the fill chance a recommendation predicted with what actually
// sold. A decision is "filled" when a confirmed auction sale of the same
// item is booked inside the prediction horizon after it was made. Inferred
// sales are excluded: they are vanished listings, which may be
// cancellations. Vendor sales are excluded too: they are a different exit
// from the auction book the prediction describes, and a vendor-arbitrage
// recommendation's fillProb is 1 by construction rather than an estimate.
//
// The comparison is descriptive. The player chooses which recommendations
// to act on, so the sample is selected; the page says so next to the table.
import { fillRules } from "@/lib/market-rules";

type CalibrationDecision = {
  itemId: number | null;
  kind: string;
  at: Date;
  fillProb: number | null;
  fillBasis: string | null;
  // Present once the player adopted the recommendation; the sale then
  // carries the same id and is a direct match, not a window guess.
  decisionId?: string | null;
};

type CalibrationTrade = {
  itemId: number;
  realizedAt: Date;
  inferred: boolean;
  channel: string;
  decisionId?: string | null;
  // The sale happened after it was listed and no later than it was
  // observed. A mailbox sale opened three days later carries a three-day
  // interval; matching it against a point time is what made lazy mailbox
  // visits look like failed predictions.
  listedAt?: Date | null;
  observedAt?: Date | null;
  censored?: boolean;
};

export type CalibrationBucket = {
  label: string;
  low: number;
  high: number;
  decisions: number;
  filled: number;
  // How the fill was attributed: identity (adopted) vs the historical
  // same-item window. The review must not present the second as a clean
  // adoption rate.
  linked: number;
  window: number;
  // Fills whose sale interval straddles the prediction horizon. Counting
  // them is the censoring-aware reading; the number is shown so a review
  // can tell how many matches are exact from how many are bounded.
  censoredMatches: number;
  rate: number; // confirmed fills / decisions
  enoughSamples: boolean;
};

function tradeInterval(trade: CalibrationTrade): { low: number; high: number } {
  const realized = trade.realizedAt.getTime();
  const low = (trade.listedAt ?? trade.realizedAt).getTime();
  const high = (trade.observedAt ?? trade.realizedAt).getTime();
  // A malformed interval still contains its observation point.
  return high >= low ? { low, high } : { low: realized, high: realized };
}

function overlapsWindow(trade: CalibrationTrade, start: number, end: number): boolean {
  const interval = tradeInterval(trade);
  return interval.high >= start && interval.low <= end;
}

const CALIBRATION_BUCKET_MIN_SAMPLES = 10;

// How far back the review page lists decisions. The outcome window is the
// prediction horizon (fillRules.horizonHours), not this number: a decision
// older than the horizon is still listed, but a later sale cannot confirm a
// prediction that only covered the first 24 hours.
export const DECISION_LOG_WINDOW_HOURS = 72;

// The review page and the cockpit's readiness meter must describe the same
// decision sample. The cockpit used to count every decision ever written,
// so it could report "ready to calibrate" while the review window held none.
export function decisionLogSince(now: Date): Date {
  return new Date(now.getTime() - DECISION_LOG_WINDOW_HOURS * 60 * 60 * 1000);
}

const BOUNDS = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

export function bucketPredictions(
  decisions: CalibrationDecision[],
  trades: CalibrationTrade[],
  windowHours = fillRules.horizonHours
): CalibrationBucket[] {
  const confirmed = trades.filter((trade) => !trade.inferred && trade.channel === "auction");
  const windowMs = windowHours * 60 * 60 * 1000;
  const usable = decisions.filter(
    (decision): decision is CalibrationDecision & { itemId: number; fillProb: number } =>
      (decision.kind === "buy" || decision.kind === "sell")
      && decision.fillBasis !== "vendor"
      && decision.itemId !== null
      && typeof decision.fillProb === "number"
      && Number.isFinite(decision.fillProb)
  );
  const buckets: CalibrationBucket[] = BOUNDS.slice(0, -1).map((low, index) => ({
    low,
    high: BOUNDS[index + 1],
    label: `${Math.round(low * 100)}–${Math.round(Math.min(BOUNDS[index + 1], 1) * 100)}%`,
    decisions: 0,
    filled: 0,
    linked: 0,
    window: 0,
    censoredMatches: 0,
    rate: 0,
    enoughSamples: false
  }));
  for (const decision of usable) {
    const bucket = buckets.find((entry) => decision.fillProb >= entry.low && decision.fillProb < entry.high)
      ?? buckets[buckets.length - 1];
    bucket.decisions += 1;
    const start = decision.at.getTime();
    // An adopted decision owns a sale through its id; the window is only
    // the fallback for the decisions written before adoption existed.
    // Identity says which decision the sale belongs to, not that it landed
    // inside the horizon the fill probability predicted: a sale four days
    // after a 24-hour prediction is still attribution, not evidence about
    // that prediction.
    // The sale's interval, not its observation point, is what can fall
    // inside the prediction window. An id match still wins over the
    // same-item window.
    const linkedTrade = decision.decisionId
      ? confirmed.find((trade) =>
          trade.decisionId === decision.decisionId
          && overlapsWindow(trade, start, start + windowMs)
        )
      : undefined;
    const windowTrade = linkedTrade ? undefined : confirmed.find((trade) =>
      trade.itemId === decision.itemId
      && overlapsWindow(trade, start, start + windowMs)
    );
    const matched = linkedTrade ?? windowTrade;
    if (matched) {
      bucket.filled += 1;
      if (linkedTrade) bucket.linked += 1;
      else bucket.window += 1;
      if (matched.censored
        || (matched.observedAt && matched.listedAt
          && matched.observedAt.getTime() - matched.listedAt.getTime() > windowMs)) {
        bucket.censoredMatches += 1;
      }
    }
  }
  for (const bucket of buckets) {
    bucket.rate = bucket.decisions > 0 ? bucket.filled / bucket.decisions : 0;
    bucket.enoughSamples = bucket.decisions >= CALIBRATION_BUCKET_MIN_SAMPLES;
  }
  return buckets;
}
