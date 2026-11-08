// The addon owns the raw history: WoWderhoiAH_Series is an append-only,
// layered log written by the scanner. The terminal receives it on every
// import, merges it into its own longer-lived copy, and reads every price
// statistic (median, trend, chart, seasonality, price index) from it.
//
// Points are stored per item as parallel arrays, the same shape the addon
// writes. One row per item keeps an import to a few thousand upserts; a
// point table would append ~3,700 rows per scan. The ceiling is 4,000
// points per item (roughly a dozen scans a day for a year); past that the
// fold drops the oldest non-event points evenly. If the cadence ever makes
// that binding, move points into a table keyed by (market, item, t).
import type { AddonScan } from "@/lib/addon-scan";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

export type SeriesPoint = {
  t: number; // epoch seconds, the scan that produced the point
  minPrice: number;
  sellPrice: number;
  quantity: number;
  numAuctions: number; // 0 on points written before the field existed
  event: boolean; // a >=10% sell-front or >=25% supply move
};

// The addon's flat log carries the item with each point; the stored shape
// keys the arrays by item, so itemId disappears after parsing.
type AddonSeriesPoint = SeriesPoint & { itemId: number };

type SeriesArrays = {
  t: number[];
  min: number[];
  sell: number[];
  q: number[];
  n: number[];
  e: number[];
};

export type AddonSeries = {
  firstScanAt: number | null;
  points: AddonSeriesPoint[];
  // Distinct scan timestamps, newest first.
  timestamps: number[];
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const DEFAULT_MAX_POINTS = 4_000;
// The addon caps its own file at 60,000 points. Anything past this is a
// corrupt or foreign file, not a market that grew.
const MAX_ADDON_POINTS = 100_000;

type LuaTable = { [key: string]: unknown };

function tableOf(value: unknown, field: string): LuaTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Addon series ${field} must be a table, got ${JSON.stringify(value)}`);
  }
  return value as LuaTable;
}

// SavedVariables positional arrays arrive keyed "1".."n". A missing or
// reordered slot means the file was not written by this pipeline; throwing
// beats reading one item's prices under another item's index.
function numberArray(value: unknown, field: string): number[] {
  const table = tableOf(value, field);
  const keys = Object.keys(table).map(Number).sort((left, right) => left - right);
  return keys.map((key, position) => {
    if (!Number.isInteger(key) || key !== position + 1) {
      throw new Error(`Addon series ${field} is not a contiguous array (found key ${key} at position ${position + 1})`);
    }
    const entry = table[String(key)];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`Addon series ${field}[${key}] must be a finite number, got ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

// Returns null when the file carries a series from another pipeline or no
// series for this market. Those are "nothing to merge", not errors: the
// scan import itself must still succeed.
export function parseAddonSeries(
  raw: unknown,
  market: { server: string; faction: string }
): AddonSeries | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as LuaTable;
  if (root.v !== SCAN_PIPELINE_VERSION) return null;
  const markets = root.markets;
  if (typeof markets !== "object" || markets === null) return null;
  const entry = (markets as LuaTable)[`${market.server}|${market.faction}`];
  if (typeof entry !== "object" || entry === null) return null;
  const scope = entry as LuaTable;
  const items = scope.items;
  if (typeof items !== "object" || items === null) return null;

  const firstScanAt = typeof scope.firstScanAt === "number" && scope.firstScanAt > 0
    ? Math.round(scope.firstScanAt)
    : null;
  const points: AddonSeriesPoint[] = [];
  const timestamps = new Set<number>();
  for (const [key, value] of Object.entries(items as LuaTable)) {
    const itemId = Number(key);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new Error(`Addon series item key must be a positive itemId, got ${JSON.stringify(key)}`);
    }
    const series = tableOf(value, `items[${itemId}]`);
    const t = numberArray(series.t, `items[${itemId}].t`);
    const min = numberArray(series.min, `items[${itemId}].min`);
    const sell = numberArray(series.sell, `items[${itemId}].sell`);
    const q = numberArray(series.q, `items[${itemId}].q`);
    // `n` and `e` arrived after the first shipped series; older points have
    // neither. Both must stay parallel when present.
    const n = series.n === undefined ? [] : numberArray(series.n, `items[${itemId}].n`);
    const e = series.e === undefined ? [] : numberArray(series.e, `items[${itemId}].e`);
    if (min.length !== t.length || sell.length !== t.length || q.length !== t.length) {
      throw new Error(`Addon series items[${itemId}] arrays disagree: t=${t.length} min=${min.length} sell=${sell.length} q=${q.length}`);
    }
    if (n.length > 0 && n.length !== t.length) {
      throw new Error(`Addon series items[${itemId}] n=${n.length} does not match t=${t.length}`);
    }
    if (e.length > 0 && e.length !== t.length) {
      throw new Error(`Addon series items[${itemId}] e=${e.length} does not match t=${t.length}`);
    }
    let previousStamp = 0;
    for (let index = 0; index < t.length; index += 1) {
      const stamp = Math.round(t[index]);
      if (stamp <= 0) throw new Error(`Addon series items[${itemId}] timestamp must be positive, got ${t[index]}`);
      if (stamp <= previousStamp) {
        throw new Error(`Addon series items[${itemId}] timestamps are not strictly increasing at point ${index + 1}`);
      }
      previousStamp = stamp;
      const minPrice = min[index];
      const sellPrice = sell[index];
      if (minPrice <= 0 || sellPrice <= 0) {
        throw new Error(`Addon series items[${itemId}] point ${index + 1} has a non-positive price`);
      }
      points.push({
        itemId,
        t: stamp,
        minPrice,
        sellPrice,
        quantity: Math.max(0, Math.round(q[index])),
        numAuctions: Math.max(0, Math.round(n[index] ?? 0)),
        event: e[index] === 1
      });
      timestamps.add(stamp);
    }
  }
  if (points.length > MAX_ADDON_POINTS) {
    throw new Error(`Addon series carries ${points.length} points, above the ${MAX_ADDON_POINTS} safety cap`);
  }
  return {
    firstScanAt,
    points,
    timestamps: Array.from(timestamps).sort((left, right) => right - left)
  };
}

// The current scan is one more point, even when the addon series is absent
// (an older addon build or a fresh market). Without it the first import
// would have no history at all and the charts would wait for a second scan.
export function scanSeriesPoints(scan: AddonScan): AddonSeriesPoint[] {
  const t = Math.round(scan.scannedAt.getTime() / 1000);
  return scan.items
    .filter((item) => item.priced && item.sellPrice > 0)
    .map((item) => ({
      itemId: item.itemId,
      t,
      minPrice: item.minPrice,
      sellPrice: item.sellPrice,
      quantity: item.quantity,
      numAuctions: item.numAuctions,
      event: false
    }));
}

function bucketOf(t: number, size: number): number {
  return Math.floor(t / size);
}

// How densely a series point is retained, decided by its age: every point
// for a week, then one per hour, day and week. The retention fold and the
// chart both need this answer, so the thresholds live here once.
export type SeriesResolution = "scan" | "hourly" | "daily" | "weekly";

export function seriesResolution(t: number, referenceSeconds: number): SeriesResolution {
  const age = Math.max(0, referenceSeconds - t);
  if (age < 7 * DAY) return "scan";
  if (age < 30 * DAY) return "hourly";
  if (age < 90 * DAY) return "daily";
  return "weekly";
}

// Layered retention, mirroring the addon's rule but over a longer window:
// every point for a week, the last point of each hour for a month, the last
// point of each day for a quarter, then the last point of each week. Event
// points survive every layer. A close is the statistic the charts and the
// median read, so a folded bucket keeps its close.
export function retainSeries(
  points: SeriesPoint[],
  nowSeconds: number,
  maxPoints = DEFAULT_MAX_POINTS
): SeriesPoint[] {
  const kept: SeriesPoint[] = [];
  let lastBucket: number | null = null;
  let lastWasEvent = false;
  for (const point of points) {
    const resolution = seriesResolution(point.t, nowSeconds);
    if (resolution === "scan") {
      kept.push(point);
      lastBucket = null;
      lastWasEvent = false;
      continue;
    }
    const size = resolution === "hourly" ? HOUR : resolution === "daily" ? DAY : WEEK;
    const bucket = bucketOf(point.t, size);
    if (bucket === lastBucket && !lastWasEvent) {
      kept.pop();
    }
    kept.push(point);
    lastBucket = bucket;
    lastWasEvent = point.event;
  }
  if (kept.length <= maxPoints) return kept;
  return foldToCap(kept, maxPoints);
}

// Keep the first and last point, every event, and the close of each equal
// slice of the span. Truncating from the old end would silently turn a
// year-long series into a week while the phase gate still asked for it.
function foldToCap(points: SeriesPoint[], maxPoints: number): SeriesPoint[] {
  if (maxPoints < 3 || points.length <= maxPoints) return points;
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const bucketSize = Math.max(1, (last - first) / (maxPoints - 2));
  const keep = new Set<number>([0, points.length - 1]);
  const lastInBucket = new Map<number, number>();
  for (let index = 1; index < points.length - 1; index += 1) {
    if (points[index].event) {
      keep.add(index);
      continue;
    }
    const bucket = Math.floor((points[index].t - first) / bucketSize);
    const previous = lastInBucket.get(bucket);
    if (previous !== undefined) keep.delete(previous);
    keep.add(index);
    lastInBucket.set(bucket, index);
  }
  return points.filter((_, index) => keep.has(index));
}

// Merge is idempotent: the same addon series imported twice produces the
// same arrays. A timestamp carries the scan, so the incoming point wins
// when it disagrees with a previously merged one (a corrected file).
export function mergeSeries(
  existing: readonly SeriesPoint[],
  incoming: readonly SeriesPoint[],
  nowSeconds: number,
  maxPoints = DEFAULT_MAX_POINTS
): SeriesPoint[] {
  const byStamp = new Map<number, SeriesPoint>();
  for (const point of existing) byStamp.set(point.t, point);
  for (const point of incoming) byStamp.set(point.t, point);
  const ordered = Array.from(byStamp.values()).sort((left, right) => left.t - right.t);
  return retainSeries(ordered, nowSeconds, maxPoints);
}

function groupSeriesPoints(points: readonly AddonSeriesPoint[]): Map<number, SeriesPoint[]> {
  const byItem = new Map<number, SeriesPoint[]>();
  for (const point of points) {
    const list = byItem.get(point.itemId) ?? [];
    list.push(point);
    byItem.set(point.itemId, list);
  }
  return byItem;
}

// The import and the migration both ask "what is this market's series for
// the items I know about?". Grouping and the per-item merge live here once.
export function mergeSeriesByItem(
  existing: ReadonlyArray<{ itemId: number; points: readonly SeriesPoint[] }>,
  incoming: readonly AddonSeriesPoint[],
  nowSeconds: number,
  maxPoints = DEFAULT_MAX_POINTS
): Map<number, SeriesPoint[]> {
  const incomingByItem = groupSeriesPoints(incoming);
  const existingById = new Map(existing.map((row) => [row.itemId, row.points]));
  const merged = new Map<number, SeriesPoint[]>();
  const ids = new Set<number>([...existingById.keys(), ...incomingByItem.keys()]);
  for (const itemId of ids) {
    const points = mergeSeries(existingById.get(itemId) ?? [], incomingByItem.get(itemId) ?? [], nowSeconds, maxPoints);
    if (points.length > 0) merged.set(itemId, points);
  }
  return merged;
}

export function seriesToArrays(points: readonly SeriesPoint[]): SeriesArrays {
  return {
    t: points.map((point) => point.t),
    min: points.map((point) => point.minPrice),
    sell: points.map((point) => point.sellPrice),
    q: points.map((point) => point.quantity),
    n: points.map((point) => point.numAuctions),
    e: points.map((point) => (point.event ? 1 : 0))
  };
}

// Prisma returns Json columns as unknown. Decoding here, once, keeps every
// consumer from re-asserting a shape the writer owns.
export function arraysToSeries(raw: unknown): SeriesPoint[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Item series points must be an object");
  }
  const arrays = raw as SeriesArrays;
  if (
    !Array.isArray(arrays.t) || !Array.isArray(arrays.min) || !Array.isArray(arrays.sell)
    || !Array.isArray(arrays.q) || !Array.isArray(arrays.n) || !Array.isArray(arrays.e)
  ) {
    throw new Error("Item series arrays must be arrays");
  }
  const length = arrays.t.length;
  if (
    arrays.min.length !== length || arrays.sell.length !== length
    || arrays.q.length !== length || arrays.n.length !== length || arrays.e.length !== length
  ) {
    throw new Error("Item series arrays are not parallel");
  }
  return arrays.t.map((t, index) => ({
    t,
    minPrice: arrays.min[index],
    sellPrice: arrays.sell[index],
    quantity: arrays.q[index],
    numAuctions: arrays.n[index],
    event: arrays.e[index] === 1
  }));
}

// Points inside the phase window, with the addon's "a retained point that
// predates the window is still one usable sample" rule.
export function seriesWindow(points: readonly SeriesPoint[], nowSeconds: number, windowHours: number): SeriesPoint[] {
  // The addon file can already contain a scan later than the one being
  // imported (the watcher replayed an older duplicate). A signal describes
  // its own scan, so points after `now` are not evidence for it.
  const upper = nowSeconds;
  if (windowHours <= 0) return points.filter((point) => point.t <= upper);
  const cutoff = upper - windowHours * HOUR;
  return points.filter((point) => point.t >= cutoff && point.t <= upper);
}

export function seriesSamples(points: readonly SeriesPoint[], nowSeconds: number, windowHours: number): number {
  if (points.length === 0) return 0;
  const count = seriesWindow(points, nowSeconds, windowHours).length;
  return count > 0 ? count : 1;
}

export function seriesSpanHours(points: readonly SeriesPoint[], nowSeconds: number, windowHours: number): number {
  const window = seriesWindow(points, nowSeconds, windowHours);
  if (window.length < 2) return 0;
  return (window[window.length - 1].t - window[0].t) / HOUR;
}

// Downsample the sell front for a table sparkline. Even spacing keeps the
// shape; taking the last N points would draw half an hour and call it a week.
export function sparkSeries(points: readonly SeriesPoint[], limit = 16): number[] {
  const priced = points.filter((point) => point.sellPrice > 0);
  if (priced.length <= limit) return priced.map((point) => point.sellPrice);
  const step = (priced.length - 1) / (limit - 1);
  const out: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    out.push(priced[Math.round(index * step)].sellPrice);
  }
  return out;
}

type DailyBar = {
  date: Date; // UTC midnight
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
};

function utcDayOf(t: number): Date {
  const date = new Date(t * 1000);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// One OHLC bar per UTC day, open = first sell front, close = last, volume =
// last listed quantity. This replaces the daily-summary table: a second
// stored copy of the same series could only drift from it.
export function seriesToDailyBars(points: readonly SeriesPoint[]): DailyBar[] {
  const byDay = new Map<number, DailyBar>();
  for (const point of points) {
    if (point.sellPrice <= 0) continue;
    const date = utcDayOf(point.t);
    const key = date.getTime();
    const bar = byDay.get(key);
    if (!bar) {
      byDay.set(key, {
        date,
        openPrice: point.sellPrice,
        closePrice: point.sellPrice,
        highPrice: point.sellPrice,
        lowPrice: point.sellPrice,
        volume: point.quantity
      });
    } else {
      bar.closePrice = point.sellPrice;
      bar.highPrice = Math.max(bar.highPrice, point.sellPrice);
      bar.lowPrice = Math.min(bar.lowPrice, point.sellPrice);
      bar.volume = point.quantity;
    }
  }
  return Array.from(byDay.values()).sort((left, right) => left.date.getTime() - right.date.getTime());
}
