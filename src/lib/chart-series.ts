// Chart-ready price series. The terminal keeps only the last 48 snapshots
// per item (about half a day), which is shorter than the 24h/7d/全部 window
// buttons the chart offers. Older days contribute their closing sell front,
// the same statistic the price index and the sell median use, so selecting
// a wider window reaches real observations instead of redrawing the same
// half-day. The current day is never counted twice: its close is derived
// from the snapshots already in the series.
import { utcDateKey } from "@/lib/deflator";
import { sellPriceOf } from "@/lib/market-data";
import { median } from "@/lib/median";

export type TimePoint = {
  ts: number;
  price: number;
  min?: number | null;
  volume?: number;
  // Where the point came from. Daily closes are one observation per day,
  // so a one-day step between them is the normal spacing, not an outage.
  kind?: "daily" | "scan";
};

export type PlottedPoint = TimePoint & { gap?: boolean };

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
        out.push({ ts: previous.ts + 1, price: null as unknown as number, min: null, gap: true });
      }
    }
    out.push(point);
  });
  return out;
}

type SnapshotLike = {
  timestamp: Date;
  sellPrice: number;
  marketPrice: number;
  minPrice: number;
  quantity: number;
};

type DailyLike = {
  date: Date;
  closePrice: number;
  lowPrice: number;
  volume: number;
};

export function buildTimeSeries(snapshots: SnapshotLike[], dailySummaries: DailyLike[]): TimePoint[] {
  const ordered = [...snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const oldestSnapshotDay = ordered.length > 0 ? utcDateKey(ordered[0].timestamp) : null;
  const dailyPoints: TimePoint[] = dailySummaries
    .filter((summary) => summary.closePrice > 0)
    .filter((summary) => oldestSnapshotDay === null || utcDateKey(summary.date) < oldestSnapshotDay)
    .map((summary) => ({
      ts: summary.date.getTime(),
      price: summary.closePrice,
      min: summary.lowPrice,
      volume: summary.volume,
      kind: "daily" as const
    }));
  const snapshotPoints: TimePoint[] = ordered.map((snapshot) => ({
    ts: snapshot.timestamp.getTime(),
    price: sellPriceOf(snapshot),
    min: snapshot.minPrice,
    volume: snapshot.quantity,
    kind: "scan" as const
  }));
  return [...dailyPoints, ...snapshotPoints].sort((left, right) => left.ts - right.ts);
}
