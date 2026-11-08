"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { MarketView, SignalSortKey } from "@/lib/market-filter";
import { buildMarketQuery, filterSortSignals, MARKET_PAGE_SIZE, paginate } from "@/lib/market-filter";
import { formatPercent } from "@/lib/utils";
import { qualityColorClass } from "@/lib/quality";
import { Coins } from "@/components/coins";
import { ItemIcon } from "@/components/item-icon";
import { WatchStar } from "@/components/watch-star";

export type MarketRow = {
  itemId: number;
  iconId: number | null;
  name: string;
  quality: string;
  category: string;
  sellPrice: number;
  minPrice: number;
  sellRef: number;
  spreadPercent: number;
  trendPercent: number;
  changePercent: number;
  quantity: number;
  numAuctions: number;
  stale: boolean;
  spark: number[];
  priceP25: number;
  priceP75: number;
};

const SORTS: Array<{ key: SignalSortKey; label: string }> = [
  { key: "spreadPercent", label: "价差%" },
  { key: "sellPrice", label: "建议卖价" },
  { key: "minPrice", label: "最低价" },
  { key: "sellRef", label: "卖价中位" },
  { key: "trendPercent", label: "趋势%" },
  { key: "changePercent", label: "环比%" },
  { key: "quantity", label: "在售量" },
  { key: "numAuctions", label: "挂单数" }
];

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-terminal-muted">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / span) * 26}`)
    .join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg viewBox="0 0 100 30" className="h-4 w-20" role="img" aria-label="近期建议卖价走势">
      <polyline points={points} fill="none" stroke={rising ? "#ff5c7a" : "#39d98a"} strokeWidth="2" />
    </svg>
  );
}

function PriceBand({ min, p25, p75, sell }: { min: number; p25: number; p75: number; sell: number }) {
  const low = Math.min(min, p25);
  const high = Math.max(p75, sell);
  const span = high - low || 1;
  return (
    <div className="relative h-1.5 w-16 bg-terminal-panel2" title={`P25–P75 ${Math.round(p25)}–${Math.round(p75)} 铜`}>
      <div
        className="absolute h-1.5 bg-terminal-border"
        style={{ left: `${((p25 - low) / span) * 100}%`, width: `${Math.max(((p75 - p25) / span) * 100, 1)}%` }}
      />
      <div className="absolute h-1.5 w-px bg-terminal-amber" style={{ left: `${((sell - low) / span) * 100}%` }} />
    </div>
  );
}

function changeClass(value: number) {
  return value >= 0 ? "text-terminal-red" : "text-terminal-green";
}

export function MarketBrowser({ rows, watchedItemIds, initialView }: {
  rows: MarketRow[];
  watchedItemIds: number[];
  initialView: MarketView;
}) {
  const [query, setQuery] = useState(initialView.query);
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState(initialView.category);
  const [sortKey, setSortKey] = useState<SignalSortKey>(initialView.sortKey);
  const [sortAsc, setSortAsc] = useState(initialView.sortAsc);
  const [sortExplicit, setSortExplicit] = useState(initialView.sortExplicit);
  const [page, setPage] = useState(initialView.page);
  const [dense, setDense] = useState(true);
  const watched = new Set(watchedItemIds);
  const categories = useMemo(
    () => Array.from(new Set(rows.map((row) => row.category))).sort(),
    [rows]
  );
  const filtered = useMemo(
    () => filterSortSignals(rows, { query: deferredQuery, category, sortKey, sortAsc, sortExplicit }),
    [rows, deferredQuery, category, sortKey, sortAsc, sortExplicit]
  );
  const visible = paginate(filtered, page, MARKET_PAGE_SIZE);

  // The URL stays shareable, but changing a filter never asks the server
  // for a new page: the whole projection is already on the client.
  useEffect(() => {
    const search = buildMarketQuery({ query, category, sortKey, sortExplicit, sortAsc, page: visible.page });
    window.history.replaceState(null, "", `/market${search ? `?${search}` : ""}`);
  }, [query, category, sortKey, sortAsc, sortExplicit, visible.page]);

  const chooseSort = (key: SignalSortKey) => {
    if (key === sortKey && sortExplicit) setSortAsc((value) => !value);
    else {
      setSortKey(key);
      setSortAsc(false);
      setSortExplicit(true);
    }
    setPage(1);
  };
  const sortMark = (key: SignalSortKey) => (sortExplicit && key === sortKey ? (sortAsc ? " ▲" : " ▼") : "");
  const inputClass = "border border-terminal-border bg-terminal-panel2 px-2 py-1 text-sm text-slate-100 focus:border-terminal-amber focus:outline-none";
  const cell = dense ? "px-2 py-1" : "px-2 py-2";

  return (
    <div>
      <div className="border-b border-terminal-border px-3 py-2 font-mono text-xs">
        <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-center">
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            placeholder="搜索物品名、ID 或 item:<id>..."
            className={`${inputClass} col-span-2 w-full placeholder:text-terminal-muted lg:w-52`}
          />
          <select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }} className={inputClass}>
            <option value="">全部品类</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select
            value={sortKey}
            onChange={(event) => { setSortKey(event.target.value as SignalSortKey); setSortExplicit(true); setPage(1); }}
            className={`${inputClass} lg:hidden`}
          >
            {SORTS.map((sort) => <option key={sort.key} value={sort.key}>{sort.label}</option>)}
          </select>
          <button onClick={() => setSortAsc((value) => !value)} className={`${inputClass} lg:hidden`} aria-label="切换排序方向">
            {sortAsc ? "升序" : "降序"}
          </button>
          <button onClick={() => setDense((value) => !value)} className={`${inputClass} hidden lg:block`}>
            {dense ? "舒适" : "紧凑"}
          </button>
          <span className="col-span-2 text-terminal-muted lg:col-span-1">{filtered.length} / {rows.length} 项</span>
          <span className="col-span-2 flex items-center justify-between gap-2 lg:ml-auto lg:justify-end">
            <button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={visible.page <= 1} className={`${inputClass} disabled:opacity-40`}>上一页</button>
            <span className="text-terminal-muted">{visible.page} / {visible.pageCount}</span>
            <button onClick={() => setPage((value) => Math.min(visible.pageCount, value + 1))} disabled={visible.page >= visible.pageCount} className={`${inputClass} disabled:opacity-40`}>下一页</button>
          </span>
        </div>
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full border-collapse font-mono text-xs tabular-nums">
          <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
            <tr>
              <th className="border-b border-terminal-border px-2 py-2 text-center">★</th>
              <th className="border-b border-terminal-border px-3 py-2 text-left">物品</th>
              {SORTS.map((sort) => (
                <th
                  key={sort.key}
                  onClick={() => chooseSort(sort.key)}
                  className="cursor-pointer select-none border-b border-terminal-border px-2 py-2 text-right hover:text-slate-200"
                >
                  {sort.label}{sortMark(sort.key)}
                </th>
              ))}
              <th className="border-b border-terminal-border px-2 py-2 text-right">走势</th>
              <th className="border-b border-terminal-border px-2 py-2 text-right">区间</th>
            </tr>
          </thead>
          <tbody>
            {visible.rows.map((row) => (
              <tr key={row.itemId} className="border-b border-terminal-border/70 hover:bg-slate-800/35">
                <td className={cell}><WatchStar itemId={row.itemId} watched={watched.has(row.itemId)} /></td>
                <td className={`${cell} text-left`}>
                  <Link href={`/items/${row.itemId}`} className={`inline-flex items-center gap-2 text-sm ${qualityColorClass(row.quality)}`}>
                    <ItemIcon iconId={row.iconId} />
                    {row.name}
                    <span className="text-[10px] text-terminal-muted">{row.category}</span>
                    {row.stale && <span className="text-[10px] text-terminal-muted">已下架</span>}
                  </Link>
                </td>
                <td className={`${cell} text-right`}><Coins copper={row.sellPrice} /></td>
                <td className={`${cell} text-right`}><Coins copper={row.minPrice} /></td>
                <td className={`${cell} text-right`}><Coins copper={row.sellRef} /></td>
                <td className={`${cell} text-right ${row.spreadPercent >= 15 ? "text-terminal-green" : "text-slate-300"}`}>{row.spreadPercent.toFixed(0)}%</td>
                <td className={`${cell} text-right ${changeClass(row.trendPercent)}`}>{formatPercent(row.trendPercent)}</td>
                <td className={`${cell} text-right ${changeClass(row.changePercent)}`}>{formatPercent(row.changePercent)}</td>
                <td className={`${cell} text-right text-slate-300`}>{row.quantity.toLocaleString()}</td>
                <td className={`${cell} text-right text-slate-300`}>{row.numAuctions.toLocaleString()}</td>
                <td className={`${cell} text-right`}><Sparkline values={row.spark} /></td>
                <td className={`${cell} text-right`}><PriceBand min={row.minPrice} p25={row.priceP25} p75={row.priceP75} sell={row.sellPrice} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-terminal-border/70 lg:hidden">
        {visible.rows.map((row) => (
          <div key={row.itemId} className="flex items-center gap-3 px-3 py-2 font-mono text-xs">
            <WatchStar itemId={row.itemId} watched={watched.has(row.itemId)} />
            <ItemIcon iconId={row.iconId} size={28} />
            <div className="min-w-0 flex-1">
              <Link href={`/items/${row.itemId}`} className={`block truncate text-sm ${qualityColorClass(row.quality)}`}>{row.name}</Link>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-terminal-muted">
                <span className="truncate">
                  {row.category} · 在售 {row.quantity.toLocaleString()}{row.stale ? " · 已下架" : ""}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Coins copper={row.sellPrice} />
                  <span className={changeClass(row.changePercent)}>{formatPercent(row.changePercent)}</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {visible.rows.length === 0 && (
        <div className="px-3 py-6 font-mono text-xs text-terminal-muted">没有匹配的物品。换个关键词或清空品类筛选。</div>
      )}
      <div className="border-t border-terminal-border px-3 py-2 font-mono text-[10px] text-terminal-muted">
        价差% = (建议卖价 − 最低价) / 建议卖价 · 趋势% = 相对阶段窗口建议卖价中位 · 环比% = 相对上一个序列点 · 区间 = 阶段窗口 P25–P75，竖线为当前建议卖价 · 搜索未点列时按相关度排序
      </div>
    </div>
  );
}
