"use client";

// View-state shell for the server-filtered market table: every control
// writes URL search params and the server re-renders just the visible
// page, so the client never receives the full signal universe.
import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { MarketSignal } from "@/lib/analytics";
import type { MarketView, SignalSortKey } from "@/lib/market-filter";
import { formatPercent } from "@/lib/utils";
import { qualityColorClass } from "@/lib/quality";
import { Coins } from "@/components/coins";
import { WatchStar } from "@/components/watch-star";
import { ItemIcon } from "@/components/item-icon";

const sortableColumns: Array<{ key: SignalSortKey; heading: string }> = [
  { key: "price", heading: "P10" },
  { key: "minPrice", heading: "最低价" },
  { key: "med7", heading: "7日中位" },
  { key: "discountPercent", heading: "折扣%" },
  { key: "changePercent", heading: "环比%" },
  { key: "quantity", heading: "在售量" },
  { key: "numAuctions", heading: "挂单数" }
];

export function MarketTable({ rows, watchedItemIds, view, categories, totalCount, filteredCount, page, pageCount }: {
  rows: MarketSignal[];
  watchedItemIds: number[];
  view: MarketView;
  categories: string[];
  totalCount: number;
  filteredCount: number;
  page: number;
  pageCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const watched = new Set(watchedItemIds);
  const [query, setQuery] = useState(view.query);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Rebuild params from the server-provided view so the URL stays the
  // single source of table state; `page` resets on any other change.
  const apply = (patch: Partial<MarketView> & { page?: number }) => {
    const next = { ...view, page: 1, ...patch };
    const params = new URLSearchParams();
    if (next.query) params.set("q", next.query);
    if (next.category) params.set("cat", next.category);
    if (next.sortKey !== "quantity") params.set("sort", next.sortKey);
    if (next.sortAsc) params.set("dir", "asc");
    if (next.page > 1) params.set("page", String(next.page));
    const search = params.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}` as Parameters<typeof router.replace>[0], { scroll: false });
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => apply({ query: value }), 300);
  };

  const toggleSort = (key: SignalSortKey) => {
    apply(key === view.sortKey ? { sortAsc: !view.sortAsc } : { sortKey: key, sortAsc: false });
  };
  const sortMark = (key: SignalSortKey) => (key === view.sortKey ? (view.sortAsc ? " ▲" : " ▼") : "");
  const inputClass = "border border-terminal-border bg-terminal-panel2 px-2 py-1 text-slate-100 focus:outline-none";

  if (totalCount === 0) {
    return (
      <div className="p-6 font-mono text-xs text-terminal-muted">
        暂无市场数据。进游戏 /wahscan 扫描拍卖行，watcher 会自动导入。
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-3 py-2 font-mono text-xs">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索物品..."
          className={`${inputClass} w-44 placeholder:text-terminal-muted`}
        />
        <select
          value={view.category}
          onChange={(event) => apply({ category: event.target.value })}
          className={inputClass}
        >
          <option value="">全部品类</option>
          {categories.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <span className="text-terminal-muted">{filteredCount} / {totalCount} 项</span>
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => apply({ page: page - 1 })}
            disabled={page <= 1}
            className={`${inputClass} disabled:opacity-40`}
          >
            上一页
          </button>
          <span className="text-terminal-muted">{page} / {pageCount}</span>
          <button
            onClick={() => apply({ page: page + 1 })}
            disabled={page >= pageCount}
            className={`${inputClass} disabled:opacity-40`}
          >
            下一页
          </button>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse font-mono text-xs">
          <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
            <tr>
              <th className="border-b border-terminal-border px-2 py-2 text-center">★</th>
              <th className="border-b border-terminal-border px-3 py-2 text-left">物品</th>
              {sortableColumns.map((column) => (
                <th
                  key={column.key}
                  onClick={() => toggleSort(column.key)}
                  className="cursor-pointer select-none border-b border-terminal-border px-3 py-2 text-right hover:text-slate-200"
                >
                  {column.heading}{sortMark(column.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((signal) => (
              <tr key={signal.itemId} className="border-b border-terminal-border/70 hover:bg-slate-800/35">
                <td className="px-2 py-2 text-center"><WatchStar itemId={signal.itemId} watched={watched.has(signal.itemId)} /></td>
                <td className="px-3 py-2 text-left">
                  <Link href={`/items/${signal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(signal.quality)}`}>
                    <ItemIcon itemId={signal.itemId} />
                    {signal.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right"><Coins copper={signal.price} /></td>
                <td className="px-3 py-2 text-right"><Coins copper={signal.minPrice} /></td>
                <td className="px-3 py-2 text-right"><Coins copper={signal.med7} /></td>
                <td className={signal.discountPercent >= 15 ? "px-3 py-2 text-right text-terminal-green" : "px-3 py-2 text-right text-slate-300"}>{signal.discountPercent.toFixed(0)}%</td>
                <td className={signal.changePercent >= 0 ? "px-3 py-2 text-right text-terminal-red" : "px-3 py-2 text-right text-terminal-green"}>{formatPercent(signal.changePercent)}</td>
                <td className="px-3 py-2 text-right text-slate-300">{signal.quantity.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-slate-300">{signal.numAuctions.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
