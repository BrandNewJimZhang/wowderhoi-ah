// Nominal prices are a currency phenomenon. The opening weeks move the
// money supply by multiples, so a +50% price can mean "more gold" rather
// than "more demand". This module builds a market-wide price index from
// the series and converts nominal prices into real ones.
import type { SeriesPoint } from "@/lib/item-series";
import { median } from "@/lib/median";

export type PriceIndex = {
  dates: string[]; // ascending UTC dates, YYYY-MM-DD
  values: number[]; // index points, first non-empty day = 100
  baseDate: string;
};

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Each item contributes one price per day — its close — so a single
// heavily scanned item cannot dominate the index. The series is the
// multi-day record; a snapshot page would only cover the last day at a
// 15-minute cadence. The median of those daily closes is normalised to the
// first day with data. Points arrive ascending, so the last point of a day
// is its close.
export function buildPriceIndex(items: Array<{ itemId: number; points: readonly SeriesPoint[] }>): PriceIndex {
  const byDate = new Map<string, Map<number, number>>();
  for (const item of items) {
    for (const point of item.points) {
      if (!point.sellPrice || point.sellPrice <= 0) continue;
      const date = utcDateKey(new Date(point.t * 1000));
      const day = byDate.get(date) ?? new Map<number, number>();
      day.set(item.itemId, point.sellPrice);
      byDate.set(date, day);
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
