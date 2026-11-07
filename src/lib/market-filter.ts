import type { MarketSignal } from "@/lib/analytics";
import { parseSearchQuery, rankSearch } from "@/lib/search";

// The runtime allow-list and the type come from one array: a new sortable
// column cannot be added to one and forgotten in the other.
const SORT_KEYS = ["sellPrice", "minPrice", "sellRef", "spreadPercent", "trendPercent", "changePercent", "quantity", "numAuctions"] as const;

export type SignalSortKey = (typeof SORT_KEYS)[number];

export type MarketView = {
  query: string;
  category: string;
  sortKey: SignalSortKey;
  // True when the URL named a column. Without it the table cannot tell its
  // default column from a player's click, and a search would stay sorted by
  // the default instead of by relevance.
  sortExplicit: boolean;
  sortAsc: boolean;
  page: number;
};

export const MARKET_PAGE_SIZE = 50;

// Serializes a view back into URL params. The default column is written
// only after the player chose it: without the flag the table cannot tell a
// default from a click, and clicking the default column while searching
// would not survive the next render.
export function buildMarketQuery(view: Pick<MarketView, "query" | "category" | "sortKey" | "sortExplicit" | "sortAsc" | "page">): string {
  const params = new URLSearchParams();
  if (view.query) params.set("q", view.query);
  if (view.category) params.set("cat", view.category);
  if (view.sortExplicit) params.set("sort", view.sortKey);
  if (view.sortAsc) params.set("dir", "asc");
  if (view.page > 1) params.set("page", String(view.page));
  return params.toString();
}

// Parses URL search params into a validated table view; unknown or
// malformed values fall back to defaults instead of leaking into queries.
export function parseMarketView(params: Record<string, string | string[] | undefined>): MarketView {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const sort = first(params.sort);
  const sortExplicit = SORT_KEYS.includes(sort as SignalSortKey);
  const page = Number.parseInt(first(params.page), 10);
  return {
    query: first(params.q),
    category: first(params.cat),
    // The cockpit opens on the widest executable spread, not on Supply.
    sortKey: sortExplicit ? (sort as SignalSortKey) : "spreadPercent",
    sortExplicit,
    sortAsc: first(params.dir) === "asc",
    page: Number.isInteger(page) && page > 0 ? page : 1
  };
}

// Single filtering/sorting authority for the market table; the client
// component holds only view state. Search semantics come from the shared
// ranking (src/lib/search.ts), the same rules the addon's box runs.
export function filterSortSignals(
  signals: MarketSignal[],
  view: { query?: string; category?: string; sortKey?: SignalSortKey; sortExplicit?: boolean; sortAsc?: boolean }
): MarketSignal[] {
  const raw = view.query ?? "";
  const query = parseSearchQuery(raw);
  let rows = signals;
  if (query) {
    // A typed number or item link addresses the item id directly; otherwise
    // every whitespace-separated token must appear anywhere in the name, so
    // "魔铁 矿" finds "魔铁矿" regardless of spacing.
    rows = rows.filter((signal) =>
      (query.id !== null && signal.itemId === query.id)
      || query.tokens.every((token) => signal.name.toLowerCase().includes(token))
    );
  }
  if (view.category) rows = rows.filter((signal) => signal.category === view.category);
  // Delisted items keep their last book in the monitor, but they must never
  // outrank a tradeable row: an old wide spread is not an opportunity.
  const freshFirst = (left: MarketSignal, right: MarketSignal) => Number(left.stale) - Number(right.stale);
  // A column the player clicked wins over relevance; relevance is then only
  // the tie-break inside equal values. A direct caller that omits the flag
  // is asking for the column it named.
  const explicit = view.sortExplicit !== false;
  if (view.sortKey && (!query || explicit)) {
    const relevance = query ? new Map(rankSearch(rows, raw).map((signal, index) => [signal.itemId, index])) : null;
    const key = view.sortKey;
    const direction = view.sortAsc ? 1 : -1;
    rows = [...rows].sort((left, right) =>
      freshFirst(left, right)
      || (left[key] - right[key]) * direction
      || (relevance ? relevance.get(left.itemId)! - relevance.get(right.itemId)! : 0)
    );
  } else if (query) {
    // No explicit column: the player typed a query, so answer it in
    // relevance order (exact, prefix, all tokens) rather than by a default
    // column that has nothing to do with what they asked for.
    rows = rankSearch(rows, raw).sort(freshFirst);
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
