// Fill-prior calibration. The priors in src/lib/market-rules.ts started as
// structural guesses; this module turns the addon's own observations into
// suggested values. It never edits the rule file: a human reads the table,
// decides, and reruns the generator.
//
// Only scans stamped observationVersion >= 2 qualify. Older rows counted
// the player's own listings as supply and the player's own purchases as
// demand, so they would calibrate the model against an echo of itself.
import { median } from "@/lib/median";
import { resolvePhase } from "@/lib/phase";
import type { MarketPhase, MarketType } from "@/lib/market-rules";

export type CalibrationRow = {
  itemId: number;
  timestamp: Date;
  marketType: string | null;
  supply: number;
  soldLow: number;
  observationVersion: number | null;
  priced: boolean;
};

export type CalibrationObservation = {
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
  options: { scanMinutes: number; breadth: number; marketOpenedAt: Date | null }
): CalibrationObservation[] {
  const floorHours = options.scanMinutes / 60;
  const byItem = new Map<number, CalibrationRow[]>();
  for (const row of rows) {
    if (!row.priced || (row.observationVersion ?? 0) < 2 || row.supply <= 0) continue;
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
      const elapsedHours = (latest.timestamp.getTime() - previous.timestamp.getTime()) / (60 * 60 * 1000);
      if (elapsedHours < floorHours || elapsedHours > 2) continue;
      // The observation belongs to the later scan: its supply is the
      // denominator, its disappearance the numerator.
      const openedAt = options.marketOpenedAt;
      const ageHours = Math.max(0, (latest.timestamp.getTime() - (openedAt?.getTime() ?? list[0].timestamp.getTime())) / (60 * 60 * 1000));
      observations.push({
        itemId: latest.itemId,
        marketType: latest.marketType as MarketType,
        phase: resolvePhase(ageHours, options.breadth),
        hazard: latest.soldLow / (latest.supply * elapsedHours)
      });
    }
  }
  return observations;
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
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
export const CALIBRATION_MIN_SAMPLES = 500;

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
