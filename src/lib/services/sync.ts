import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Connection } from "../db/schema";
import { connectorFor } from "../connectors/registry";
import { isoDate } from "../connectors/http";
import type { AudienceRow, MetricPoint, PostRecord, SyncRange } from "../connectors/types";
import { freshContext, handleConnectorError, setStatus } from "./connections";

export type SyncScope = "account" | "posts" | "audience" | "all";

const BACKFILL_DAYS = 90;
const INCREMENTAL_DAYS = 7;
const POST_REFRESH_DAYS = 30;

function range(days: number): SyncRange {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  return { since, until };
}

export type SyncStats = {
  metrics?: number;
  posts?: number;
  audience?: number;
};

/** Führt den Sync für eine Verbindung aus und schreibt die Ergebnisse in die DB. */
export async function runSync(conn: Connection, scope: SyncScope, opts: { backfillDays?: number } = {}): Promise<SyncStats> {
  const db = await getDb();
  const connector = connectorFor(conn.network);
  const stats: SyncStats = {};
  const first = !conn.lastSyncAt;
  try {
    const ctx = await freshContext(conn);
    if (scope === "account" || scope === "all") {
      const points = await connector.syncAccount(ctx, range(opts.backfillDays ?? (first ? BACKFILL_DAYS : INCREMENTAL_DAYS)));
      stats.metrics = await upsertMetrics(conn.id, points);
    }
    if (scope === "posts" || scope === "all") {
      const posts = await connector.syncPosts(ctx, range(opts.backfillDays ?? (first ? BACKFILL_DAYS : POST_REFRESH_DAYS)));
      stats.posts = await upsertPosts(conn.id, posts);
    }
    if (scope === "audience" || scope === "all") {
      const rows = await connector.syncAudience(ctx);
      stats.audience = await replaceAudience(conn.id, rows);
    }
    await db
      .update(schema.connections)
      .set({ lastSyncAt: new Date(), status: "active", statusMessage: null, updatedAt: new Date() })
      .where(eq(schema.connections.id, conn.id));
    await db.insert(schema.syncLogs).values({ id: crypto.randomUUID(), connectionId: conn.id, scope, ok: true, stats });
    return stats;
  } catch (err) {
    const { retry } = await handleConnectorError(conn, err);
    await db.insert(schema.syncLogs).values({
      id: crypto.randomUUID(),
      connectionId: conn.id,
      scope,
      ok: false,
      message: ((err as Error).message ?? String(err)).slice(0, 2000),
      stats,
    });
    const e = err instanceof Error ? err : new Error(String(err));
    (e as Error & { retry?: boolean }).retry = retry;
    throw e;
  }
}

export async function upsertMetrics(connectionId: string, points: MetricPoint[]): Promise<number> {
  const db = await getDb();
  // Duplikate (gleiche Metrik + Tag) zusammenfassen: letzter Wert gewinnt.
  const map = new Map<string, MetricPoint>();
  for (const p of points) {
    if (!Number.isFinite(p.value)) continue;
    map.set(`${p.metric}|${p.date}`, p);
  }
  const rows = [...map.values()];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(schema.metricDaily)
      .values(chunk.map((p) => ({ connectionId, metric: p.metric, date: p.date, value: p.value })))
      .onConflictDoUpdate({
        target: [schema.metricDaily.connectionId, schema.metricDaily.metric, schema.metricDaily.date],
        set: { value: sql`excluded.value`, updatedAt: new Date() },
      });
  }
  return rows.length;
}

export async function upsertPosts(connectionId: string, posts: PostRecord[]): Promise<number> {
  const db = await getDb();
  if (posts.length === 0) return 0;
  const today = isoDate(new Date());
  const seen = new Map<string, PostRecord>();
  for (const p of posts) seen.set(p.externalId, p);
  const unique = [...seen.values()];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    await db
      .insert(schema.posts)
      .values(
        chunk.map((p) => ({
          id: crypto.randomUUID(),
          connectionId,
          externalId: p.externalId,
          type: p.type,
          title: p.title ?? null,
          caption: p.caption ?? null,
          permalink: p.permalink ?? null,
          mediaUrl: p.mediaUrl ?? null,
          thumbnailUrl: p.thumbnailUrl ?? null,
          publishedAt: p.publishedAt,
          raw: p.raw ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.posts.connectionId, schema.posts.externalId],
        set: {
          type: sql`excluded.type`,
          title: sql`excluded.title`,
          caption: sql`excluded.caption`,
          permalink: sql`excluded.permalink`,
          mediaUrl: sql`excluded.media_url`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          raw: sql`excluded.raw`,
          updatedAt: new Date(),
        },
      });
    const ids = await db
      .select({ id: schema.posts.id, externalId: schema.posts.externalId })
      .from(schema.posts)
      .where(
        inArray(
          schema.posts.externalId,
          chunk.map((p) => p.externalId),
        ),
      );
    const idByExternal = new Map(ids.filter((r) => r).map((r) => [r.externalId, r.id]));
    const metricRows: { postId: string; metric: string; date: string; value: number }[] = [];
    for (const p of chunk) {
      const postId = idByExternal.get(p.externalId);
      if (!postId) continue;
      for (const [metric, value] of Object.entries(p.metrics)) {
        if (!Number.isFinite(value)) continue;
        metricRows.push({ postId, metric, date: today, value });
      }
    }
    for (let j = 0; j < metricRows.length; j += 500) {
      await db
        .insert(schema.postMetrics)
        .values(metricRows.slice(j, j + 500))
        .onConflictDoUpdate({
          target: [schema.postMetrics.postId, schema.postMetrics.metric, schema.postMetrics.date],
          set: { value: sql`excluded.value` },
        });
    }
  }
  return unique.length;
}

export async function replaceAudience(connectionId: string, rows: AudienceRow[]): Promise<number> {
  const db = await getDb();
  if (rows.length === 0) return 0;
  const dims = [...new Set(rows.map((r) => r.dimension))];
  await db.delete(schema.audience).where(sql`${schema.audience.connectionId} = ${connectionId} and ${schema.audience.dimension} in ${dims}`);
  const map = new Map<string, AudienceRow>();
  for (const r of rows) map.set(`${r.dimension}|${r.key}`, r);
  const unique = [...map.values()];
  for (let i = 0; i < unique.length; i += 500) {
    await db.insert(schema.audience).values(
      unique.slice(i, i + 500).map((r) => ({ connectionId, dimension: r.dimension, key: r.key, value: r.value, capturedAt: new Date() })),
    );
  }
  return unique.length;
}

export async function markSyncing(conn: Connection) {
  if (conn.status === "error") await setStatus(conn.id, "active", null);
}
