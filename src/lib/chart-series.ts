// Chart-ready price series. The terminal keeps only the last 48 snapshots
// per item (about half a day), which is shorter than the 24h/7d/全部 window
// buttons the chart offers. Older days contribute their closing sell front,
// the same statistic the price index and the sell median use, so selecting
// a wider window reaches real observations instead of redrawing the same
// half-day. The current day is never counted twice: its close is derived
// from the snapshots already in the series.
import { utcDateKey } from "@/lib/deflator";

export type TimePoint = { ts: number; price: number; min?: number | null; volume?: number };

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
      volume: summary.volume
    }));
  const snapshotPoints: TimePoint[] = ordered.map((snapshot) => ({
    ts: snapshot.timestamp.getTime(),
    // Legacy rows imported before the sell front existed carry 0 there.
    price: snapshot.sellPrice > 0 ? snapshot.sellPrice : snapshot.marketPrice,
    min: snapshot.minPrice,
    volume: snapshot.quantity
  }));
  return [...dailyPoints, ...snapshotPoints].sort((left, right) => left.ts - right.ts);
}
