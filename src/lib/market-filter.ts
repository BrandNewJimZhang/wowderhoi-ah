import type { MarketSignal } from "@/lib/analytics";

export type SignalSortKey = "price" | "minPrice" | "med7" | "discountPercent" | "changePercent" | "quantity" | "numAuctions";

const SORT_KEYS: readonly SignalSortKey[] = ["price", "minPrice", "med7", "discountPercent", "changePercent", "quantity", "numAuctions"];

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
    sortKey: SORT_KEYS.includes(sort as SignalSortKey) ? (sort as SignalSortKey) : "quantity",
    sortAsc: first(params.dir) === "asc",
    page: Number.isInteger(page) && page > 0 ? page : 1
  };
}

// Single filtering/sorting authority for the market table; the client
// component holds only view state.
export function filterSortSignals(
  signals: MarketSignal[],
  view: { query?: string; category?: string; minPriceCopper?: number; sortKey?: SignalSortKey; sortAsc?: boolean }
): MarketSignal[] {
  const query = (view.query ?? "").trim().toLowerCase();
  let rows = signals;
  if (query) rows = rows.filter((signal) => signal.name.toLowerCase().includes(query));
  if (view.category) rows = rows.filter((signal) => signal.category === view.category);
  if (view.minPriceCopper) rows = rows.filter((signal) => signal.price >= view.minPriceCopper!);
  if (view.sortKey) {
    const key = view.sortKey;
    const direction = view.sortAsc ? 1 : -1;
    rows = [...rows].sort((left, right) => (left[key] - right[key]) * direction);
  }
  return rows;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const clamped = Math.min(Math.max(page, 1), pageCount);
  return { rows: rows.slice((clamped - 1) * pageSize, clamped * pageSize), page: clamped, pageCount };
}
