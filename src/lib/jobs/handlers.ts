import "server-only";
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Job } from "../db/schema";
import { env } from "../env";
import { enqueue } from "./queue";
import { getConnection, freshContext } from "../services/connections";
import { runSync, type SyncScope } from "../services/sync";
import { checkTarget, publishTarget } from "../services/publishing";

export type Handler = (job: Job) => Promise<unknown>;

const syncHandler =
  (scope: SyncScope): Handler =>
  async (job) => {
    const connectionId = String(job.payload.connectionId ?? "");
    const conn = await getConnection(connectionId);
    if (!conn) return { skipped: "connection missing" };
    if (conn.status === "reauth_required" || conn.status === "disconnected") return { skipped: conn.status };
    const backfillDays = typeof job.payload.backfillDays === "number" ? job.payload.backfillDays : undefined;
    return runSync(conn, scope, { backfillDays });
  };

export const handlers: Record<string, Handler> = {
  "sync.account": syncHandler("account"),
  "sync.posts": syncHandler("posts"),
  "sync.audience": syncHandler("audience"),
  "sync.all": syncHandler("all"),

  "token.refresh": async (job) => {
    const conn = await getConnection(String(job.payload.connectionId ?? ""));
    if (!conn) return { skipped: true };
    await freshContext(conn);
    return { refreshed: true };
  },

  "publish.target": async (job) => {
    const result = await publishTarget(String(job.payload.targetId ?? ""));
    return result ?? { skipped: true };
  },

  "publish.check": async (job) => {
    const status = await checkTarget(String(job.payload.targetId ?? ""));
    if (status === "processing") {
      const attempt = job.attempts;
      const delay = Math.min(10 * 60_000, 60_000 * attempt);
      await enqueue("publish.check", job.payload, { runAt: new Date(Date.now() + delay), uniqueKey: `publish:check:${job.payload.targetId}:${attempt}`, maxAttempts: 1 });
    }
    return { status };
  },

  /** Periodischer Tick: fällige Syncs, Token-Refreshes und Veröffentlichungen einreihen. */
  "schedule.tick": async () => {
    const db = await getDb();
    const now = new Date();
    const intervalMs = env().SYNC_INTERVAL_MINUTES * 60_000;
    const conns = await db.query.connections.findMany({ where: eq(schema.connections.status, "active") });
    let syncs = 0;
    let refreshes = 0;
    for (const c of conns) {
      if (!c.lastSyncAt || c.lastSyncAt.getTime() < now.getTime() - intervalMs) {
        await enqueue("sync.all", { connectionId: c.id }, { uniqueKey: `sync:all:${c.id}` });
        syncs++;
      }
      if (c.tokenExpiresAt && c.tokenExpiresAt.getTime() < now.getTime() + 2 * 60 * 60_000) {
        await enqueue("token.refresh", { connectionId: c.id }, { uniqueKey: `token:refresh:${c.id}` });
        refreshes++;
      }
    }
    // Fällige Veröffentlichungen, deren Job fehlt (z. B. nach Datenverlust der Queue)
    const due = await db
      .select({ id: schema.publishTargets.id })
      .from(schema.publishTargets)
      .innerJoin(schema.scheduledPosts, eq(schema.publishTargets.scheduledPostId, schema.scheduledPosts.id))
      .where(and(eq(schema.publishTargets.status, "pending"), lte(schema.scheduledPosts.scheduledAt, now), or(eq(schema.scheduledPosts.status, "scheduled"), eq(schema.scheduledPosts.status, "publishing"))));
    for (const t of due) await enqueue("publish.target", { targetId: t.id }, { uniqueKey: `publish:target:${t.id}`, maxAttempts: 3 });
    // Hängende "processing"-Ziele weiter prüfen
    const processing = await db.query.publishTargets.findMany({ where: and(eq(schema.publishTargets.status, "processing"), isNotNull(schema.publishTargets.externalId)) });
    for (const t of processing) await enqueue("publish.check", { targetId: t.id }, { uniqueKey: `publish:check:${t.id}:tick`, runAt: new Date(now.getTime() + 30_000), maxAttempts: 1 });
    // Alte erledigte Jobs aufräumen (7 Tage)
    const old = await db.query.jobs.findMany({ where: and(inArray(schema.jobs.status, ["done", "failed"]), lte(schema.jobs.updatedAt, new Date(now.getTime() - 7 * 86_400_000))), limit: 500 });
    if (old.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, old.map((j) => j.id)));
    return { syncs, refreshes, due: due.length, processing: processing.length };
  },
};
