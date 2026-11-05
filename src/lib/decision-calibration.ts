// Compares the fill chance a recommendation predicted with what actually
// sold. A decision is "filled" when a confirmed sale of the same item is
// booked inside the window after it was made. Inferred sales are excluded:
// they are vanished listings, which may be cancellations.
//
// The comparison is descriptive. The player chooses which recommendations
// to act on, so the sample is selected; the page says so next to the table.
export type CalibrationDecision = {
  itemId: number | null;
  kind: string;
  at: Date;
  fillProb: number | null;
};

export type CalibrationTrade = {
  itemId: number;
  realizedAt: Date;
  inferred: boolean;
};

export type CalibrationBucket = {
  label: string;
  low: number;
  high: number;
  decisions: number;
  filled: number;
  rate: number; // confirmed fills / decisions
  enoughSamples: boolean;
};

const CALIBRATION_BUCKET_MIN_SAMPLES = 10;

// How long after a decision a sale still counts as its outcome. The review
// page queries decisions over the same window, so the table never mixes a
// 72-hour comparison with a three-scan decision set.
export const CALIBRATION_WINDOW_HOURS = 72;

const BOUNDS = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

export function bucketPredictions(
  decisions: CalibrationDecision[],
  trades: CalibrationTrade[],
  windowHours = CALIBRATION_WINDOW_HOURS
): CalibrationBucket[] {
  const confirmed = trades.filter((trade) => !trade.inferred);
  const windowMs = windowHours * 60 * 60 * 1000;
  const usable = decisions.filter(
    (decision): decision is CalibrationDecision & { itemId: number; fillProb: number } =>
      decision.kind === "buy"
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
    rate: 0,
    enoughSamples: false
  }));
  for (const decision of usable) {
    const bucket = buckets.find((entry) => decision.fillProb >= entry.low && decision.fillProb < entry.high)
      ?? buckets[buckets.length - 1];
    bucket.decisions += 1;
    const start = decision.at.getTime();
    const filled = confirmed.some((trade) =>
      trade.itemId === decision.itemId
      && trade.realizedAt.getTime() >= start
      && trade.realizedAt.getTime() <= start + windowMs
    );
    if (filled) bucket.filled += 1;
  }
  for (const bucket of buckets) {
    bucket.rate = bucket.decisions > 0 ? bucket.filled / bucket.decisions : 0;
    bucket.enoughSamples = bucket.decisions >= CALIBRATION_BUCKET_MIN_SAMPLES;
  }
  return buckets;
}
