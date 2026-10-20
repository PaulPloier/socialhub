import "server-only";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Connection, Post } from "../db/schema";
import { connectorFor } from "../connectors/registry";
import type { MetricAggregation, MetricDef } from "../connectors/types";
import { isoDate } from "../connectors/http";

export interface Period {
  from: string; // YYYY-MM-DD
  to: string;
}

export function defaultPeriod(days = 28): Period {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: isoDate(from), to: isoDate(to) };
}

export function previousPeriod(p: Period): Period {
  const from = new Date(`${p.from}T00:00:00Z`);
  const to = new Date(`${p.to}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return { from: isoDate(new Date(from.getTime() - days * 86_400_000)), to: isoDate(new Date(from.getTime() - 86_400_000)) };
}

export interface SeriesPoint {
  date: string;
  [metric: string]: number | string | null;
}

/** Zeitreihe mehrerer Metriken einer Verbindung, ein Objekt pro Tag. */
export async function timeseries(connectionId: string, metrics: string[], period: Period): Promise<SeriesPoint[]> {
  const db = await getDb();
  if (metrics.length === 0) return [];
  const rows = await db
    .select({ metric: schema.metricDaily.metric, date: schema.metricDaily.date, value: schema.metricDaily.value })
    .from(schema.metricDaily)
    .where(
      and(
        eq(schema.metricDaily.connectionId, connectionId),
        inArray(schema.metricDaily.metric, metrics),
        gte(schema.metricDaily.date, period.from),
        lte(schema.metricDaily.date, period.to),
      ),
    )
    .orderBy(schema.metricDaily.date);
  const byDate = new Map<string, SeriesPoint>();
  for (const r of rows) {
    const p = byDate.get(r.date) ?? { date: r.date };
    p[r.metric] = r.value;
    byDate.set(r.date, p);
  }
  return [...byDate.values()];
}

export interface KpiValue {
  metric: string;
  label: string;
  aggregation: MetricAggregation;
  value: number | null;
  previous: number | null;
  changePct: number | null;
}

function aggregate(values: { date: string; value: number }[], agg: MetricAggregation): number | null {
  if (values.length === 0) return null;
  if (agg === "sum") return values.reduce((a, b) => a + b.value, 0);
  if (agg === "avg") return values.reduce((a, b) => a + b.value, 0) / values.length;
  return values.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!.value;
}

/** Kennzahlen (aktuelle vs. vorherige Periode) für eine Verbindung. */
export async function kpis(conn: Connection, period: Period, defs?: MetricDef[]): Promise<KpiValue[]> {
  const db = await getDb();
  const metricDefs = defs ?? connectorFor(conn.network).accountMetrics;
  const prev = previousPeriod(period);
  const rows = await db
    .select({ metric: schema.metricDaily.metric, date: schema.metricDaily.date, value: schema.metricDaily.value })
    .from(schema.metricDaily)
    .where(and(eq(schema.metricDaily.connectionId, conn.id), gte(schema.metricDaily.date, prev.from), lte(schema.metricDaily.date, period.to)));
  const out: KpiValue[] = [];
  for (const def of metricDefs) {
    const cur = rows.filter((r) => r.metric === def.key && r.date >= period.from && r.date <= period.to);
    const old = rows.filter((r) => r.metric === def.key && r.date >= prev.from && r.date <= prev.to);
    const value = aggregate(cur, def.aggregation);
    const previous = aggregate(old, def.aggregation);
    const changePct = value !== null && previous !== null && previous !== 0 ? ((value - previous) / Math.abs(previous)) * 100 : null;
    if (value === null && previous === null) continue;
    out.push({ metric: def.key, label: def.label, aggregation: def.aggregation, value, previous, changePct });
  }
  return out;
}

export interface PostWithMetrics extends Post {
  metrics: Record<string, number>;
}

/** Posts einer Verbindung inkl. jeweils letztem Metrik-Snapshot. */
export async function postsWithMetrics(connectionId: string, opts: { period?: Period; limit?: number; sortBy?: string } = {}): Promise<PostWithMetrics[]> {
  const db = await getDb();
  const conditions = [eq(schema.posts.connectionId, connectionId)];
  if (opts.period) {
    conditions.push(gte(schema.posts.publishedAt, new Date(`${opts.period.from}T00:00:00Z`)));
    conditions.push(lte(schema.posts.publishedAt, new Date(`${opts.period.to}T23:59:59Z`)));
  }
  const posts = await db.query.posts.findMany({ where: and(...conditions), orderBy: desc(schema.posts.publishedAt), limit: opts.limit ?? 200 });
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);
  // Letzter Snapshot pro Post und Metrik
  const latest = await db
    .select({
      postId: schema.postMetrics.postId,
      metric: schema.postMetrics.metric,
      value: schema.postMetrics.value,
      date: schema.postMetrics.date,
    })
    .from(schema.postMetrics)
    .where(inArray(schema.postMetrics.postId, ids))
    .orderBy(schema.postMetrics.postId, schema.postMetrics.metric, desc(schema.postMetrics.date));
  const metricsByPost = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  for (const r of latest) {
    const k = `${r.postId}|${r.metric}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const m = metricsByPost.get(r.postId) ?? {};
    m[r.metric] = r.value;
    metricsByPost.set(r.postId, m);
  }
  const out = posts.map((p) => ({ ...p, metrics: metricsByPost.get(p.id) ?? {} }));
  if (opts.sortBy) {
    const key = opts.sortBy;
    out.sort((a, b) => (b.metrics[key] ?? -1) - (a.metrics[key] ?? -1));
  }
  return out;
}

export async function audience(connectionId: string): Promise<Record<string, { key: string; value: number }[]>> {
  const db = await getDb();
  const rows = await db.query.audience.findMany({ where: eq(schema.audience.connectionId, connectionId) });
  const out: Record<string, { key: string; value: number }[]> = {};
  for (const r of rows) (out[r.dimension] ??= []).push({ key: r.key, value: r.value });
  for (const dim of Object.keys(out)) out[dim].sort((a, b) => b.value - a.value);
  return out;
}

export interface ConnectionOverview {
  connection: Pick<Connection, "id" | "network" | "name" | "username" | "pictureUrl" | "status" | "statusMessage" | "lastSyncAt">;
  kpis: KpiValue[];
  topPosts: { id: string; externalId: string; type: string; caption: string | null; permalink: string | null; publishedAt: Date; metrics: Record<string, number> }[];
  postCount: number;
}

/** Komplettübersicht einer Brand für Dashboard, Reports und MCP. */
export async function brandOverview(brandId: string, period: Period, topN = 5): Promise<ConnectionOverview[]> {
  const db = await getDb();
  const conns = await db.query.connections.findMany({ where: eq(schema.connections.brandId, brandId), orderBy: schema.connections.network });
  const out: ConnectionOverview[] = [];
  for (const c of conns) {
    const posts = await postsWithMetrics(c.id, { period });
    const primary = primaryMetric(c);
    const top = posts
      .slice()
      .sort((a, b) => (b.metrics[primary] ?? 0) - (a.metrics[primary] ?? 0))
      .slice(0, topN)
      .map((p) => ({ id: p.id, externalId: p.externalId, type: p.type, caption: p.caption?.slice(0, 160) ?? null, permalink: p.permalink, publishedAt: p.publishedAt, metrics: p.metrics }));
    out.push({
      connection: { id: c.id, network: c.network, name: c.name, username: c.username, pictureUrl: c.pictureUrl, status: c.status, statusMessage: c.statusMessage, lastSyncAt: c.lastSyncAt },
      kpis: await kpis(c, period),
      topPosts: top,
      postCount: posts.length,
    });
  }
  return out;
}

export function primaryMetric(conn: Pick<Connection, "network">): string {
  switch (conn.network) {
    case "facebook":
    case "linkedin":
    case "x":
      return "impressions";
    default:
      return "views";
  }
}

export async function metricCoverage(connectionId: string): Promise<{ metric: string; days: number; from: string | null; to: string | null }[]> {
  const db = await getDb();
  const rows = await db
    .select({
      metric: schema.metricDaily.metric,
      days: sql<number>`count(*)`,
      from: sql<string>`min(${schema.metricDaily.date})`,
      to: sql<string>`max(${schema.metricDaily.date})`,
    })
    .from(schema.metricDaily)
    .where(eq(schema.metricDaily.connectionId, connectionId))
    .groupBy(schema.metricDaily.metric);
  return rows.map((r) => ({ metric: r.metric, days: Number(r.days), from: r.from, to: r.to }));
}
