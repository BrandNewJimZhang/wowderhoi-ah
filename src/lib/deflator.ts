// Nominal prices are a currency phenomenon. The opening weeks move the
// money supply by multiples, so a +50% price can mean "more gold" rather
// than "more demand". This module builds a market-wide price index from
// the scans and converts nominal prices into real ones.
import { sellPriceOf, type MarketHistory } from "@/lib/market-data";
import { median } from "@/lib/median";

export type PriceIndex = {
  dates: string[]; // ascending UTC dates, YYYY-MM-DD
  values: number[]; // index points, first non-empty day = 100
  baseDate: string;
};

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Each item contributes one price per day (its close), so a single
// heavily scanned item cannot dominate the index. Daily summaries are the
// multi-day record: the universe query only keeps the last 48 snapshots,
// which is half a day at the 15-minute cadence, so snapshots alone could
// never produce an index that spans more than one day. Recent snapshots
// still refine the current day's close. The daily median is normalised to
// the first day with data.
export function buildPriceIndex(items: MarketHistory[]): PriceIndex {
  const byDate = new Map<string, Map<number, number>>();
  const record = (date: string, itemId: number, price: number) => {
    if (!price || price <= 0) return;
    const day = byDate.get(date) ?? new Map<number, number>();
    day.set(itemId, price);
    byDate.set(date, day);
  };
  for (const item of items) {
    for (const summary of item.dailySummaries) {
      record(utcDateKey(summary.date), item.itemId, summary.closePrice);
    }
    const snapshots = [...item.snapshots].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    for (const snapshot of snapshots) {
      record(utcDateKey(snapshot.timestamp), item.itemId, sellPriceOf(snapshot));
    }
  }
  const dates = Array.from(byDate.keys()).sort();
  const medians = dates.map((date) => median(Array.from(byDate.get(date)!.values())));
  const base = medians.find((value) => value > 0) ?? 0;
  if (base <= 0) return { dates: [], values: [], baseDate: "" };
  const values = medians.map((value) => (value > 0 ? (value / base) * 100 : 0));
  return { dates, values, baseDate: dates[medians.findIndex((value) => value > 0)] };
}

// The latest index at or before `date`. A missing day carries the last
// known level forward; it never interpolates a level that was not observed.
export function indexFor(index: PriceIndex, date: Date): number | null {
  const key = utcDateKey(date);
  let result: number | null = null;
  for (let cursor = 0; cursor < index.dates.length; cursor += 1) {
    if (index.dates[cursor] > key) break;
    if (index.values[cursor] > 0) result = index.values[cursor];
  }
  return result;
}

export function realPrice(price: number, date: Date, index: PriceIndex): number | null {
  const level = indexFor(index, date);
  if (!level || level <= 0) return null;
  return (price / level) * 100;
}
