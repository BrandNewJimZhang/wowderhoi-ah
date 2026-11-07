import type { MarketSignal } from "@/lib/analytics";

// The runtime allow-list and the type come from one array: a new sortable
// column cannot be added to one and forgotten in the other.
const SORT_KEYS = ["sellPrice", "minPrice", "sellRef", "spreadPercent", "trendPercent", "changePercent", "quantity", "numAuctions"] as const;

export type SignalSortKey = (typeof SORT_KEYS)[number];

export type MarketView = { query: string; category: string; sortKey: SignalSortKey; sortAsc: boolean; page: number };

export const MARKET_PAGE_SIZE = 50;

// Parses URL search params into a validated table view; unknown or
// malformed values fall back to defaults instead of leaking into queries.
export function parseMarketView(params: Record<string, string | string[] | undefined>): MarketView {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const sort = first(params.sort);
  const page = Number.parseInt(first(params.page), 10);
  return {
    query: first(params.q),
    category: first(params.cat),
    // The cockpit opens on the widest executable spread, not on Supply.
    sortKey: SORT_KEYS.includes(sort as SignalSortKey) ? (sort as SignalSortKey) : "spreadPercent",
    sortAsc: first(params.dir) === "asc",
    page: Number.isInteger(page) && page > 0 ? page : 1
  };
}

// Single filtering/sorting authority for the market table; the client
// component holds only view state.
export function filterSortSignals(
  signals: MarketSignal[],
  view: { query?: string; category?: string; sortKey?: SignalSortKey; sortAsc?: boolean }
): MarketSignal[] {
  const query = (view.query ?? "").trim().toLowerCase();
  let rows = signals;
  if (query) {
    // A typed number addresses the item id directly; otherwise every
    // whitespace-separated token must appear anywhere in the name, so
    // "魔铁 矿" finds "魔铁矿" regardless of spacing.
    const id = /^\d+$/.test(query) ? Number(query) : null;
    const tokens = query.split(/\s+/);
    rows = rows.filter((signal) =>
      (id !== null && signal.itemId === id)
      || tokens.every((token) => signal.name.toLowerCase().includes(token))
    );
  }
  if (view.category) rows = rows.filter((signal) => signal.category === view.category);
  // Delisted items keep their last book in the monitor, but they must never
  // outrank a tradeable row: an old wide spread is not an opportunity.
  const freshFirst = (left: MarketSignal, right: MarketSignal) => Number(left.stale) - Number(right.stale);
  if (view.sortKey) {
    const key = view.sortKey;
    const direction = view.sortAsc ? 1 : -1;
    rows = [...rows].sort((left, right) => freshFirst(left, right) || (left[key] - right[key]) * direction);
  } else {
    rows = [...rows].sort(freshFirst);
  }
  return rows;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const clamped = Math.min(Math.max(page, 1), pageCount);
  return { rows: rows.slice((clamped - 1) * pageSize, clamped * pageSize), page: clamped, pageCount };
}
