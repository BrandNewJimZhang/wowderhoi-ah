"use client";

import { useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { formatWowMoney } from "@/lib/wow-money";
import { fillCurve } from "@/lib/fill";
import { median } from "@/lib/median";
import type { FillBasis } from "@/lib/core/types";

const formatGold = (copper: number) => formatWowMoney(copper, { compact: true });
const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

const tooltipStyle = { background: "#10141d", border: "1px solid #263042", color: "#dce3ef" };
const axisStyle = { fill: "#8d96a8", fontSize: 11 };

// ============================ Time series ============================

export type TimePoint = { ts: number; price: number; min?: number | null; volume?: number };

const WINDOWS = [
  { key: "1h", hours: 1 },
  { key: "6h", hours: 6 },
  { key: "24h", hours: 24 },
  { key: "7d", hours: 168 },
  { key: "全部", hours: 0 }
] as const;

function withGapBreaks(points: TimePoint[]): Array<TimePoint & { gap?: boolean }> {
  if (points.length < 3) return points;
  const gaps = points.slice(1).map((point, index) => point.ts - points[index].ts);
  const interval = median(gaps);
  const out: Array<TimePoint & { gap?: boolean }> = [];
  points.forEach((point, index) => {
    if (index > 0 && point.ts - points[index - 1].ts > interval * 3) {
      // A scanning outage is a hole, not a straight line through it.
      out.push({ ts: points[index - 1].ts + 1, price: null as unknown as number, min: null, gap: true });
    }
    out.push(point);
  });
  return out;
}

// Time-proportional X axis: gaps in scanning render as real gaps, so
// the trend shape is honest about when data actually exists.
export function TimeSeriesChart({ data }: { data: TimePoint[] }) {
  const [windowKey, setWindowKey] = useState<string>("全部");
  const filtered = useMemo(() => {
    const window = WINDOWS.find((entry) => entry.key === windowKey) ?? WINDOWS[4];
    if (window.hours === 0 || data.length === 0) return data;
    const cutoff = data[data.length - 1].ts - window.hours * 60 * 60 * 1000;
    return data.filter((point) => point.ts >= cutoff);
  }, [data, windowKey]);
  const points = useMemo(() => withGapBreaks(filtered), [filtered]);
  const prices = filtered.flatMap((point) => [point.price, point.min ?? point.price]).filter((value): value is number => typeof value === "number" && value > 0);
  const min = prices.length > 0 ? Math.min(...prices) : 0;
  const max = prices.length > 0 ? Math.max(...prices) : 0;
  const logScale = min > 0 && max / min > 4;

  const formatClock = (ts: number) => {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1 font-mono text-[10px]">
        {WINDOWS.map((window) => (
          <button
            key={window.key}
            onClick={() => setWindowKey(window.key)}
            className={`border px-2 py-0.5 ${window.key === windowKey ? "border-terminal-amber text-terminal-amber" : "border-terminal-border text-terminal-muted hover:text-slate-200"}`}
          >
            {window.key}
          </button>
        ))}
        {logScale && <span className="ml-2 text-terminal-muted">对数轴</span>}
        <span className="ml-auto text-terminal-muted">建议卖价（橙） · 最低价（灰） · 在售量（柱）</span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={points} margin={{ top: 18, right: 20, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatClock}
            tick={axisStyle}
          />
          <YAxis
            yAxisId="price"
            scale={logScale ? "log" : "auto"}
            domain={logScale ? [min, max] : ["auto", "auto"]}
            allowDataOverflow
            tick={axisStyle}
            tickFormatter={formatGold}
            width={72}
          />
          <YAxis yAxisId="volume" orientation="right" tick={axisStyle} width={54} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(value) => formatClock(Number(value))}
            formatter={(value, name) => {
              if (name === "volume") return [String(value), "在售量"];
              if (name === "min") return [formatGold(Number(value)), "最低价"];
              return [formatGold(Number(value)), "建议卖价"];
            }}
          />
          <Bar yAxisId="volume" dataKey="volume" fill="#263f5c" opacity={0.7} />
          <Line yAxisId="price" type="monotone" dataKey="price" connectNulls={false} dot={{ r: 2 }} stroke="#ff9933" strokeWidth={2} />
          <Line yAxisId="price" type="monotone" dataKey="min" connectNulls={false} dot={false} stroke="#8d96a8" strokeWidth={1} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============================ Order book =============================

export type BookTier = { p: number; q: number };

export function OrderBookChart({ tiers, sellP, minPrice }: { tiers: BookTier[]; sellP: number; minPrice: number }) {
  const data = useMemo(
    () => [...tiers]
      .sort((left, right) => left.p - right.p)
      .reduce<Array<{ price: number; qty: number; cumulative: number }>>((rows, tier) => {
        const previous = rows.length === 0 ? 0 : rows[rows.length - 1].cumulative;
        rows.push({ price: tier.p, qty: tier.q, cumulative: previous + tier.q });
        return rows;
      }, []),
    [tiers]
  );
  if (data.length === 0) {
    return <div className="p-4 font-mono text-xs text-terminal-muted">本次扫描没有盘口数据</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 18, right: 20, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
        <XAxis dataKey="price" type="number" domain={["dataMin", "dataMax"]} tick={axisStyle} tickFormatter={formatGold} />
        <YAxis tick={axisStyle} width={54} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(value) => `价位 ${formatGold(Number(value))}`}
          formatter={(value, name) => (name === "cumulative" ? [String(value), "累计在售"] : [String(value), "该价位"])}
        />
        <Area type="stepAfter" dataKey="cumulative" fill="#1f3a5c" stroke="#56c7ff" strokeWidth={2} />
        <ReferenceLine x={minPrice} stroke="#8d96a8" strokeDasharray="4 3" label={{ value: "最低", fill: "#8d96a8", fontSize: 10 }} />
        <ReferenceLine x={sellP} stroke="#ff9933" strokeDasharray="4 3" label={{ value: "卖价", fill: "#ff9933", fontSize: 10 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ======================= Fill probability ============================

const FILL_BASIS_LABELS: Record<Exclude<FillBasis, "vendor">, string> = {
  own: "基于自己的成交",
  proxy: "基于公共推断消失（区间）",
  prior: "基于阶段先验（尚无自己的成交）"
};

export function FillProbabilityChart({ tiers, hazardPerHour, basis, quantity, band = 0.35 }: { tiers: BookTier[]; hazardPerHour: number; basis: Exclude<FillBasis, "vendor">; quantity: number; band?: number }) {
  const data = fillCurve(tiers, hazardPerHour, 24, band, quantity);
  if (data.length === 0) {
    return <div className="p-4 font-mono text-xs text-terminal-muted">没有盘口深度，无法估计成交概率</div>;
  }
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] text-terminal-muted">
        24 小时成交概率 · {FILL_BASIS_LABELS[basis]}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 18, right: 20, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
          <XAxis dataKey="price" type="number" domain={["dataMin", "dataMax"]} tick={axisStyle} tickFormatter={formatGold} />
          <YAxis domain={[0, 1]} tick={axisStyle} tickFormatter={formatPercent} width={48} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(value) => `价位 ${formatGold(Number(value))}`}
            formatter={(value, name) => {
              if (name === "fill") return [formatPercent(Number(value)), "成交概率"];
              if (Array.isArray(value)) return [`${formatPercent(Number(value[0]))} - ${formatPercent(Number(value[1]))}`, "区间"];
              return [String(value), String(name)];
            }}
          />
          <Area dataKey="band" fill="#2c4a33" stroke="none" isAnimationActive={false} />
          <Line type="monotone" dataKey="fill" dot={{ r: 2 }} stroke="#39d98a" strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============================= Candles ==============================

type CandlePoint = { label: string; open: number; close: number; high: number; low: number; volume: number };

type CandleShapeProps = {
  x?: number;
  width?: number;
  y?: number;
  height?: number;
  payload?: CandlePoint;
  background?: { y: number; height: number };
};

function CandleShape(props: CandleShapeProps) {
  const { x = 0, width = 0, payload, background } = props;
  if (!payload || !background || background.height <= 0) return <g />;
  const { open, close, high, low } = payload;
  const range = high - low || 1;
  const top = props.y ?? background.y;
  const pixelHeight = props.height ?? background.height;
  const pixelFor = (value: number) => top + ((high - value) / range) * pixelHeight;
  const rising = close >= open;
  const color = rising ? "#39d98a" : "#ff5c7a";
  const bodyTop = pixelFor(Math.max(open, close));
  const bodyBottom = pixelFor(Math.min(open, close));
  const centerX = x + width / 2;
  return (
    <g>
      <line x1={centerX} x2={centerX} y1={pixelFor(high)} y2={pixelFor(low)} stroke={color} strokeWidth={1} />
      <rect
        x={x + width * 0.2}
        width={Math.max(width * 0.6, 2)}
        y={bodyTop}
        height={Math.max(bodyBottom - bodyTop, 1)}
        fill={color}
      />
    </g>
  );
}

export function CandlestickChart({ data }: { data: CandlePoint[] }) {
  const withRange = data.map((point) => ({ ...point, lowHigh: [point.low, point.high] as [number, number] }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={withRange} margin={{ top: 18, right: 20, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={axisStyle} />
        <YAxis yAxisId="price" domain={["dataMin", "dataMax"]} tick={axisStyle} tickFormatter={formatGold} width={72} />
        <YAxis yAxisId="volume" orientation="right" tick={axisStyle} width={54} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => {
            if (name === "volume") return [String(value), "在售量"];
            if (Array.isArray(value)) return [`${formatGold(Number(value[0]))} - ${formatGold(Number(value[1]))}`, "低-高"];
            return [formatGold(Number(value)), String(name)];
          }}
        />
        <Bar yAxisId="volume" dataKey="volume" fill="#263f5c" opacity={0.6} />
        <Bar yAxisId="price" dataKey="lowHigh" shape={<CandleShape />} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
