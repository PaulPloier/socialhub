"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export interface SeriesDef {
  key: string;
  label: string;
}

export function TimeSeriesChart({ data, series, height = 260 }: { data: Record<string, number | string | null>[]; series: SeriesDef[]; height?: number }) {
  if (data.length === 0) return <div className="flex h-40 items-center justify-center text-sm text-zinc-400">Noch keine Daten</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#f1f1f4" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
        <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v: number) => compact(v)} />
        <Tooltip formatter={(v) => (typeof v === "number" ? v.toLocaleString("de-AT") : String(v))} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12 }} />
        {series.map((s, i) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function HorizontalBars({ data, height }: { data: { key: string; value: number }[]; height?: number }) {
  if (data.length === 0) return <div className="flex h-24 items-center justify-center text-sm text-zinc-400">Keine Daten</div>;
  const h = height ?? Math.max(120, data.length * 26);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="key" width={110} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => (typeof v === "number" ? v.toLocaleString("de-AT", { maximumFractionDigits: 1 }) : String(v))} contentStyle={{ fontSize: 12 }} />
        <Bar dataKey="value" fill="#4f46e5" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function compact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}
