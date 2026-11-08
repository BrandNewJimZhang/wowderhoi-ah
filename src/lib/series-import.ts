// Parses the addon's compact history log (WoWderhoiAH_Series) and picks the
// scans the terminal has not imported yet. The full scan snapshot is
// "current state" and is replaced by every scan; the series is the append-only
// history and is the only affordable way to deliver scans the watcher missed.
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

export type SeriesPoint = {
  timestamp: number; // epoch seconds, the scan that produced the point
  itemId: number;
  minPrice: number;
  sellPrice: number;
  quantity: number;
  numAuctions: number; // 0 on points written before the field existed
};

export type AddonSeries = {
  firstScanAt: number | null;
  points: SeriesPoint[];
  // Distinct scan timestamps, newest first.
  timestamps: number[];
};

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
// series for this market. Those are "nothing to backfill", not errors: the
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
  const points: SeriesPoint[] = [];
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
    // `n` arrived after the first shipped series; older points have none.
    const n = series.n === undefined ? [] : numberArray(series.n, `items[${itemId}].n`);
    if (min.length !== t.length || sell.length !== t.length || q.length !== t.length) {
      throw new Error(`Addon series items[${itemId}] arrays disagree: t=${t.length} min=${min.length} sell=${sell.length} q=${q.length}`);
    }
    if (n.length > 0 && n.length !== t.length) {
      throw new Error(`Addon series items[${itemId}] n=${n.length} does not match t=${t.length}`);
    }
    for (let index = 0; index < t.length; index += 1) {
      const stamp = Math.round(t[index]);
      if (stamp <= 0) throw new Error(`Addon series items[${itemId}] timestamp must be positive, got ${t[index]}`);
      const minPrice = min[index];
      const sellPrice = sell[index];
      if (minPrice <= 0 || sellPrice <= 0) {
        throw new Error(`Addon series items[${itemId}] point ${index + 1} has a non-positive price`);
      }
      const quantity = Math.max(0, Math.round(q[index]));
      points.push({
        timestamp: stamp,
        itemId,
        minPrice,
        sellPrice,
        quantity,
        numAuctions: Math.max(0, Math.round(n[index] ?? 0))
      });
      timestamps.add(stamp);
    }
  }
  return {
    firstScanAt,
    points,
    timestamps: Array.from(timestamps).sort((left, right) => right - left)
  };
}

export type SeriesDayAggregate = {
  itemId: number;
  date: Date; // UTC midnight
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
};

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date: Date): string {
  return utcDay(date).toISOString().slice(0, 10);
}

// Backfilled points are price observations, not full scans: they carry no
// ladder, sellers or flow. Fold them into one OHLC row per item and day. The
// current day is excluded: the current scan's own merge is authoritative
// there, and a partial history point must not set its open or close.
export function aggregateSeriesDays(points: SeriesPoint[], currentScanAt: Date): SeriesDayAggregate[] {
  const currentDay = dayKey(currentScanAt);
  const byKey = new Map<string, SeriesDayAggregate>();
  for (const point of points) {
    const date = new Date(point.timestamp * 1000);
    if (dayKey(date) === currentDay) continue;
    const key = `${dayKey(date)}|${point.itemId}`;
    const aggregate = byKey.get(key);
    if (!aggregate) {
      byKey.set(key, {
        itemId: point.itemId,
        date: utcDay(date),
        openPrice: point.sellPrice,
        closePrice: point.sellPrice,
        highPrice: point.sellPrice,
        lowPrice: point.sellPrice,
        volume: point.quantity
      });
    } else {
      aggregate.closePrice = point.sellPrice;
      aggregate.highPrice = Math.max(aggregate.highPrice, point.sellPrice);
      aggregate.lowPrice = Math.min(aggregate.lowPrice, point.sellPrice);
      aggregate.volume = point.quantity;
    }
  }
  return Array.from(byKey.values());
}

export type SeriesBackfill = {
  // Oldest first, so daily OHLC folds in causal order.
  points: SeriesPoint[];
  timestamps: number[];
  skipped: number;
};

// Every retained timestamp older than the current scan and absent from the
// database is a scan the terminal never saw. Only the newest `limit` are
// delivered so one import stays bounded; the rest remain in the addon file.
// The caller owns `limit` because it also reports the cap to the operator.
export function selectSeriesBackfill(
  series: AddonSeries,
  existingTimestamps: Iterable<number>,
  currentScanAt: number,
  limit: number
): SeriesBackfill {
  const existing = new Set(existingTimestamps);
  const missing = series.timestamps.filter(
    (stamp) => stamp < currentScanAt && !existing.has(stamp)
  );
  const selected = missing.slice(0, Math.max(0, limit));
  const chosen = new Set(selected);
  return {
    points: series.points
      .filter((point) => chosen.has(point.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp || left.itemId - right.itemId),
    timestamps: [...selected].sort((left, right) => left - right),
    skipped: missing.length - selected.length
  };
}
