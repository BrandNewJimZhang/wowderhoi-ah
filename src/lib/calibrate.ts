// Fill-prior calibration. The priors in src/lib/market-rules.ts started as
// structural guesses; this module turns the addon's own observations into
// suggested values. It never edits the rule file: a human reads the table,
// decides, and reruns the generator.
//
// Only scans stamped with the current OBSERVATION_VERSION qualify. Older
// rows counted the player's own listings as supply and the player's own
// purchases as demand, so they would calibrate the model against an echo
// of itself. A book with hidden owners is excluded for the same reason: its
// lower edge is zero by construction, which is missing data, not evidence
// that nothing sold.
import { median, quantile } from "@/lib/median";
import { ageHours, resolvePhase } from "@/lib/phase";
import { OBSERVATION_VERSION, type MarketPhase, type MarketType } from "@/lib/market-rules";

export type CalibrationRow = {
  itemId: number;
  timestamp: Date;
  marketType: string | null;
  supply: number;
  soldLow: number;
  observationVersion: number | null;
  priced: boolean;
  sellersInvisible: boolean;
  // Absent on rows imported before the flag existed; only an explicit false
  // (no previous capture of this item) disqualifies the row.
  flowObserved?: boolean;
};

type CalibrationScope = {
  scanMinutes: number;
  marketOpenedAt: Date | null;
  // Priced items per scan timestamp (epoch ms). Breadth is a property of
  // the whole market, so it must include rows this module never learns
  // from -- hidden-owner books and pre-hygiene scans.
  breadthByScan: Map<number, number>;
  // The oldest priced scan, used as the age anchor when no opening time is
  // configured.
  marketFirstScanAt: Date | null;
};

type CalibrationObservation = {
  itemId: number;
  marketType: MarketType;
  phase: MarketPhase;
  hazard: number; // units per unit-supply per hour
};

export type CalibrationBucket = {
  phase: MarketPhase;
  marketType: MarketType;
  samples: number;
  medianHazard: number;
  p25: number;
  p75: number;
};

// Adjacent scans of the same item, a plausible gap apart. A gap outside
// [scan floor, 2h] is a paused addon or a manual rescan, not a rate.
export function calibrationObservations(
  rows: CalibrationRow[],
  options: CalibrationScope
): CalibrationObservation[] {
  const floorHours = options.scanMinutes / 60;
  const anchor = options.marketOpenedAt?.getTime() ?? options.marketFirstScanAt?.getTime() ?? null;
  const byItem = new Map<number, CalibrationRow[]>();
  for (const row of rows) {
    if (!row.priced || (row.observationVersion ?? 0) < OBSERVATION_VERSION || row.supply <= 0) continue;
    if (row.sellersInvisible) continue;
    if (row.flowObserved === false) continue;
    if (row.marketType !== "commodity" && row.marketType !== "item") continue;
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }
  const observations: CalibrationObservation[] = [];
  for (const list of byItem.values()) {
    list.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const latest = list[index];
      const latestAt = latest.timestamp.getTime();
      const elapsedHours = (latestAt - previous.timestamp.getTime()) / (60 * 60 * 1000);
      if (elapsedHours < floorHours || elapsedHours > 2) continue;
      // The observation belongs to the later scan: its supply is the
      // denominator, its disappearance the numerator. Age and breadth come
      // from that scan's whole market, not from this item's own history:
      // an item that first appeared late is not a young market.
      const age = ageHours(new Date(latestAt), anchor === null ? null : new Date(anchor));
      observations.push({
        itemId: latest.itemId,
        marketType: latest.marketType as MarketType,
        phase: resolvePhase(age, options.breadthByScan.get(latestAt) ?? 0),
        hazard: latest.soldLow / (latest.supply * elapsedHours)
      });
    }
  }
  return observations;
}

export function summarizeCalibration(observations: CalibrationObservation[]): CalibrationBucket[] {
  const groups = new Map<string, CalibrationObservation[]>();
  for (const observation of observations) {
    const key = `${observation.phase}|${observation.marketType}`;
    const list = groups.get(key) ?? [];
    list.push(observation);
    groups.set(key, list);
  }
  const phases: MarketPhase[] = ["ignition", "wave", "settle", "steady"];
  const types: MarketType[] = ["commodity", "item"];
  const buckets: CalibrationBucket[] = [];
  for (const phase of phases) {
    for (const marketType of types) {
      const list = groups.get(`${phase}|${marketType}`) ?? [];
      if (list.length === 0) continue;
      const hazards = list.map((observation) => observation.hazard).sort((left, right) => left - right);
      buckets.push({
        phase,
        marketType,
        samples: hazards.length,
        medianHazard: median(hazards),
        p25: quantile(hazards, 0.25),
        p75: quantile(hazards, 0.75)
      });
    }
  }
  return buckets;
}

// A bucket only becomes a suggestion with enough independent item-level
// observations; below this the script says so instead of printing noise.
const CALIBRATION_MIN_SAMPLES = 500;

export function formatCalibration(buckets: CalibrationBucket[]): string[] {
  const lines = ["phase     type       samples  median/h   p25/h      p75/h"];
  for (const bucket of buckets) {
    const enough = bucket.samples >= CALIBRATION_MIN_SAMPLES;
    lines.push(
      `${bucket.phase.padEnd(9)} ${bucket.marketType.padEnd(10)} ${String(bucket.samples).padEnd(8)} `
      + `${bucket.medianHazard.toFixed(4).padEnd(10)} ${bucket.p25.toFixed(4).padEnd(10)} ${bucket.p75.toFixed(4)}`
      + (enough ? "" : "  (样本不足)")
    );
  }
  if (buckets.every((bucket) => bucket.samples < CALIBRATION_MIN_SAMPLES)) {
    lines.push(`样本不足：至少需要 ${CALIBRATION_MIN_SAMPLES} 条物品级观测才输出建议值。`);
  }
  return lines;
}
