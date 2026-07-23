"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatWowMoney } from "@/lib/wow-money";

const formatGold = (copper: number) => formatWowMoney(copper, { compact: true });

type TimePoint = { ts: number; price: number; volume?: number };

const formatClock = (ts: number) => {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// Time-proportional X axis: gaps in scanning render as real gaps, so
// the trend shape is honest about when data actually exists.
export function TimeSeriesChart({ data }: { data: TimePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 18, right: 20, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={formatClock}
          tick={{ fill: "#8d96a8", fontSize: 11 }}
        />
        <YAxis yAxisId="price" domain={["auto", "auto"]} tick={{ fill: "#8d96a8", fontSize: 11 }} tickFormatter={formatGold} width={72} />
        <YAxis yAxisId="volume" orientation="right" tick={{ fill: "#8d96a8", fontSize: 11 }} width={54} />
        <Tooltip
          contentStyle={{ background: "#10141d", border: "1px solid #263042", color: "#dce3ef" }}
          labelFormatter={(value) => formatClock(Number(value))}
          formatter={(value, name) => (name === "volume" ? [String(value), "在售量"] : [formatGold(Number(value)), "P50"])}
        />
        <Bar yAxisId="volume" dataKey="volume" fill="#263f5c" opacity={0.7} />
        <Line yAxisId="price" type="monotone" dataKey="price" dot={{ r: 2 }} stroke="#56c7ff" strokeWidth={2} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

type CandlePoint = { label: string; open: number; close: number; high: number; low: number; volume: number };

// Recharts has no candlestick primitive; each candle renders through a
// custom Bar shape spanning [low, high] with the body at [open, close].
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
  // props.y/height describe the [low, high] bar span in pixels.
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
        <XAxis dataKey="label" tick={{ fill: "#8d96a8", fontSize: 11 }} />
        <YAxis
          yAxisId="price"
          domain={["dataMin", "dataMax"]}
          tick={{ fill: "#8d96a8", fontSize: 11 }}
          tickFormatter={formatGold}
          width={72}
        />
        <YAxis yAxisId="volume" orientation="right" tick={{ fill: "#8d96a8", fontSize: 11 }} width={54} />
        <Tooltip
          contentStyle={{ background: "#10141d", border: "1px solid #263042", color: "#dce3ef" }}
          formatter={(value, name) => {
            if (name === "volume") return [String(value), "成交量"];
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