import "server-only";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Job } from "../db/schema";

/**
 * DB-basierte Job-Queue (vergleichbar mit pg-boss / graphile-worker, aber ohne
 * zusätzliche Infrastruktur). Läuft mit PGlite und Postgres. Jobs sind
 * idempotent über `uniqueKey` (z. B. "sync:account:<connectionId>").
 */

export type JobType =
  | "sync.account"
  | "sync.posts"
  | "sync.audience"
  | "sync.all"
  | "token.refresh"
  | "publish.target"
  | "publish.check"
  | "schedule.tick";

export interface EnqueueOptions {
  runAt?: Date;
  uniqueKey?: string;
  maxAttempts?: number;
}

export async function enqueue(type: JobType, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  if (opts.uniqueKey) {
    // Existiert bereits ein wartender/laufender Job mit diesem Key, nichts tun.
    const existing = await db.query.jobs.findFirst({
      where: and(eq(schema.jobs.uniqueKey, opts.uniqueKey), or(eq(schema.jobs.status, "queued"), eq(schema.jobs.status, "running"))),
    });
    if (existing) {
      // Frühere Ausführung erlauben, wenn der neue Wunschzeitpunkt früher liegt.
      if (opts.runAt && existing.status === "queued" && existing.runAt > opts.runAt) {
        await db.update(schema.jobs).set({ runAt: opts.runAt, updatedAt: new Date() }).where(eq(schema.jobs.id, existing.id));
      }
      return existing.id;
    }
    // Abgeschlossene Jobs mit demselben Key freigeben (Unique-Index).
    await db.update(schema.jobs).set({ uniqueKey: null }).where(eq(schema.jobs.uniqueKey, opts.uniqueKey));
  }
  await db.insert(schema.jobs).values({
    id,
    type,
    payload,
    uniqueKey: opts.uniqueKey ?? null,
    runAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 5,
  });
  return id;
}

const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** Holt den nächsten fälligen Job und markiert ihn als laufend. */
export async function claimNext(): Promise<Job | null> {
  const db = await getDb();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  // Hängende Jobs (Prozess abgestürzt) wieder freigeben.
  await db
    .update(schema.jobs)
    .set({ status: "queued", lockedAt: null, updatedAt: now })
    .where(and(eq(schema.jobs.status, "running"), lte(schema.jobs.lockedAt, staleBefore)));

  const candidate = await db.query.jobs.findFirst({
    where: and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, now)),
    orderBy: [asc(schema.jobs.runAt), asc(schema.jobs.createdAt)],
  });
  if (!candidate) return null;
  const claimed = await db
    .update(schema.jobs)
    .set({ status: "running", lockedAt: now, attempts: sql`${schema.jobs.attempts} + 1`, updatedAt: now })
    .where(and(eq(schema.jobs.id, candidate.id), eq(schema.jobs.status, "queued"), isNull(schema.jobs.lockedAt)))
    .returning();
  return claimed[0] ?? null;
}

export async function complete(job: Job, result?: unknown): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.jobs)
    .set({ status: "done", result: result ?? null, lockedAt: null, updatedAt: new Date() })
    .where(eq(schema.jobs.id, job.id));
}

export async function fail(job: Job, error: unknown, opts: { retry?: boolean } = {}): Promise<void> {
  const db = await getDb();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const retry = (opts.retry ?? true) && job.attempts < job.maxAttempts;
  const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** (job.attempts - 1));
  await db
    .update(schema.jobs)
    .set({
      status: retry ? "queued" : "failed",
      runAt: retry ? new Date(Date.now() + delayMs) : job.runAt,
      lastError: message.slice(0, 4000),
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, job.id));
}

export async function recentJobs(limit = 50): Promise<Job[]> {
  const db = await getDb();
  return db.query.jobs.findMany({ orderBy: (t, { desc }) => desc(t.updatedAt), limit });
}

export async function getJob(id: string): Promise<Job | undefined> {
  const db = await getDb();
  return db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) });
}

/** Wartet (polling) bis ein Job fertig ist – für synchrone MCP-Aufrufe. */
export async function waitForJob(id: string, timeoutMs = 120_000): Promise<Job | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await getJob(id);
    if (!j || j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return getJob(id);
}
