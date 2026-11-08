// Chart-ready price series. The addon's layered history is the only input:
// it already stretches from per-scan points to weekly closes, so the
// 24h/7d/全部 buttons reach real observations instead of redrawing a
// display window.
import { seriesResolution, type SeriesPoint, type SeriesResolution } from "@/lib/item-series";
import { median } from "@/lib/median";

export type TimePoint = {
  ts: number;
  // Null marks a gap inserted between two observations; the chart draws a
  // break instead of connecting them.
  price: number | null;
  min?: number | null;
  volume?: number;
  // How densely the point was retained. A change of resolution is a normal
  // step, not an outage: hourly and daily closes sit further apart than
  // fifteen-minute scans by design.
  kind?: SeriesResolution;
};

type PlottedPoint = TimePoint & { gap?: boolean };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function resolutionOf(point: TimePoint): SeriesResolution {
  return point.kind ?? "scan";
}

// The normal spacing of a folded point. Scan spacing is the observed
// median, because the live cadence is set by the scanner, not by a constant.
function stepOf(kind: SeriesResolution, scanInterval: number | null): number | null {
  switch (kind) {
    case "hourly": return HOUR_MS;
    case "daily": return DAY_MS;
    case "weekly": return WEEK_MS;
    default: return scanInterval;
  }
}

// A scanning outage is a hole, not a straight line through it. Each gap is
// measured against its own resolution: the folded history is expected to
// widen from scans to hourly, daily and weekly closes, so a global median
// would turn every folded point into a disconnected dot.
export function withGapBreaks(points: TimePoint[]): PlottedPoint[] {
  if (points.length < 3) return points;
  const scanGaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = resolutionOf(points[index - 1]);
    const current = resolutionOf(points[index]);
    if (previous === "scan" && current === "scan") {
      scanGaps.push(points[index].ts - points[index - 1].ts);
    }
  }
  const scanInterval = scanGaps.length > 0 ? median(scanGaps) : null;
  const out: PlottedPoint[] = [];
  points.forEach((point, index) => {
    if (index > 0) {
      const previous = points[index - 1];
      const gap = point.ts - previous.ts;
      const previousKind = resolutionOf(previous);
      const currentKind = resolutionOf(point);
      // Live scans jitter enough that a skipped scan is normal; only three
      // cadences without a point is an outage. A folded close is stamped on
      // a fixed grid, so missing one bucket is already a hole. At a change
      // of resolution the step can be a full wider bucket — a daily close
      // exists only at the day boundary the fold picked, and the first live
      // scan after it can be almost a day later — so the junction gets twice
      // the wider step before it reads as an outage.
      const broken = previousKind === "scan" && currentKind === "scan"
        ? scanInterval !== null && gap > scanInterval * 3
        : (() => {
            const step = stepOf(previousKind, scanInterval);
            const next = stepOf(currentKind, scanInterval);
            if (step === null || next === null) return false;
            const factor = previousKind === currentKind ? 1.5 : 2;
            return gap > Math.max(step, next) * factor;
          })();
      if (broken) {
        out.push({ ts: previous.ts + 1, price: null, min: null, gap: true });
      }
    }
    out.push(point);
  });
  return out;
}

export function buildTimeSeries(points: readonly SeriesPoint[]): TimePoint[] {
  // The retention fold decides a point's resolution by its age, so the
  // newest observation is the reference for the whole series.
  const reference = points.length > 0 ? points[points.length - 1].t : 0;
  return points
    .filter((point) => point.sellPrice > 0)
    .map((point) => ({
      ts: point.t * 1000,
      price: point.sellPrice,
      min: point.minPrice,
      volume: point.quantity,
      kind: seriesResolution(point.t, reference)
    }));
}
