// Demand priors for the opening weeks. These are structural beliefs, not
// fitted parameters: bags, wands, potions, food and ammunition are needed
// before the first level-60 wave, while armor demand is diffuse. The prior
// multiplies the ignition score only; once own fills exist, the fill
// probability carries the evidence.
import bandsFile from "@/data/demand-bands.json";

export type DemandBand = {
  classes: string[];
  subClasses: string[];
  weight: number;
  levelBand?: string;
  peakDay?: number;
  note?: string;
};

export const demandBands = bandsFile.bands as DemandBand[];

function matches(names: string[], value: string | undefined): boolean {
  if (names.includes("*")) return true;
  if (!value) return false;
  const needle = value.trim().toLowerCase();
  return names.some((name) => name.trim().toLowerCase() === needle);
}

function demandBandFor(category?: string, subCategory?: string): DemandBand | null {
  for (const band of demandBands) {
    if (matches(band.classes, category) && matches(band.subClasses, subCategory)) return band;
  }
  return null;
}

export function demandFor(category?: string, subCategory?: string): number {
  return demandBandFor(category, subCategory)?.weight ?? 1;
}
