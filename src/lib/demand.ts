// Demand priors for the opening weeks. These are structural beliefs, not
// fitted parameters: bags, wands, potions, food and ammunition are needed
// before the first level-60 wave, while armor demand is diffuse. The prior
// multiplies the ignition score only; once own fills exist, the fill
// probability carries the evidence.
import bandsFile from "@/data/demand-bands.json";

type DemandBand = {
  classes: string[];
  subClasses: string[];
  weight: number;
  levelBand?: string;
  peakDay?: number;
  note?: string;
};

export const demandBands = bandsFile.bands as DemandBand[];

// Exact, case-insensitive comparison -- the same rule Core.demandFor runs.
// Trimming here (and not there) made a padded category match in the terminal
// and miss in game. The bands are compiled verbatim into WAH.DEMAND, so the
// two runtimes see one canonical string; a padded value is simply a miss on
// both sides.
function matches(names: string[], value: string | undefined): boolean {
  if (names.includes("*")) return true;
  if (!value) return false;
  const needle = value.toLowerCase();
  return names.some((name) => name.toLowerCase() === needle);
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
