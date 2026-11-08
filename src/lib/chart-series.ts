// Chart-ready price series. The addon's layered history is the only input:
// it already stretches from per-scan points to weekly closes, so the
// 24h/7d/全部 buttons reach real observations instead of redrawing a
// display window.
import type { SeriesPoint } from "@/lib/item-series";
import { median } from "@/lib/median";

export type TimePoint = {
  ts: number;
  // Null marks a gap inserted between two observations; the chart draws a
  // break instead of connecting them.
  price: number | null;
  min?: number | null;
  volume?: number;
  // Where the point came from. Daily closes are one observation per day,
  // so a one-day step between them is the normal spacing, not an outage.
  kind?: "daily" | "scan";
};

type PlottedPoint = TimePoint & { gap?: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;

// A scanning outage is a hole, not a straight line through it. The gap
// threshold comes from the scan cadence alone: measuring it over a mixed
// series would compare one-day daily closes against fifteen-minute scans
// and break the daily segment into disconnected dots.
export function withGapBreaks(points: TimePoint[]): PlottedPoint[] {
  if (points.length < 3) return points;
  const scanGaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].kind !== "daily" && points[index - 1].kind !== "daily") {
      scanGaps.push(points[index].ts - points[index - 1].ts);
    }
  }
  const interval = scanGaps.length > 0 ? median(scanGaps) : null;
  const out: PlottedPoint[] = [];
  points.forEach((point, index) => {
    if (index > 0) {
      const previous = points[index - 1];
      const gap = point.ts - previous.ts;
      // A daily close is dated at midnight, so the step from the last close
      // to the first intraday scan is under 48 hours by construction: that
      // junction is a resolution change, not an outage. Two daily closes one
      // day apart are the normal cadence; a missing day is 48 hours.
      const bothDaily = point.kind === "daily" && previous.kind === "daily";
      const mixed = (point.kind === "daily") !== (previous.kind === "daily");
      const broken = bothDaily
        ? gap > 1.5 * DAY_MS
        : mixed
          ? gap > 2 * DAY_MS
          : interval !== null && gap > interval * 3;
      if (broken) {
        out.push({ ts: previous.ts + 1, price: null, min: null, gap: true });
      }
    }
    out.push(point);
  });
  return out;
}

export function buildTimeSeries(points: readonly SeriesPoint[]): TimePoint[] {
  return points
    .filter((point) => point.sellPrice > 0)
    .map((point) => ({
      ts: point.t * 1000,
      price: point.sellPrice,
      min: point.minPrice,
      volume: point.quantity,
      kind: "scan" as const
    }));
}
