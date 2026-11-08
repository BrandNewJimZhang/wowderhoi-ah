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
  rate: number; // confirmed fills / decisions
  enoughSamples: boolean;
};

const CALIBRATION_BUCKET_MIN_SAMPLES = 10;

// How far back the review page lists decisions. The outcome window is the
// prediction horizon (fillRules.horizonHours), not this number: a decision
// older than the horizon is still listed, but a later sale cannot confirm a
// prediction that only covered the first 24 hours.
export const DECISION_LOG_WINDOW_HOURS = 72;

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
      decision.kind === "buy"
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
    const linked = decision.decisionId
      ? confirmed.some((trade) =>
          trade.decisionId === decision.decisionId
          && trade.realizedAt.getTime() >= start
          && trade.realizedAt.getTime() <= start + windowMs
        )
      : false;
    const windowMatch = !linked && confirmed.some((trade) =>
      trade.itemId === decision.itemId
      && trade.realizedAt.getTime() >= start
      && trade.realizedAt.getTime() <= start + windowMs
    );
    if (linked) {
      bucket.filled += 1;
      bucket.linked += 1;
    } else if (windowMatch) {
      bucket.filled += 1;
      bucket.window += 1;
    }
  }
  for (const bucket of buckets) {
    bucket.rate = bucket.decisions > 0 ? bucket.filled / bucket.decisions : 0;
    bucket.enoughSamples = bucket.decisions >= CALIBRATION_BUCKET_MIN_SAMPLES;
  }
  return buckets;
}
