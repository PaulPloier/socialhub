import "server-only";
import fs from "node:fs";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { PublishTarget, ScheduledPost } from "../db/schema";
import { connectorFor } from "../connectors/registry";
import type { PublishResult } from "../connectors/types";
import { enqueue } from "../jobs/queue";
import { freshContext, getConnection, handleConnectorError } from "./connections";
import { getMedia, mediaLocalPath, mediaPublicUrl } from "./media";

export interface TargetInput {
  connectionId: string;
  options?: Record<string, unknown>;
}

export interface CreateScheduledPostInput {
  brandId: string;
  mediaId: string | null;
  text: string;
  title?: string | null;
  scheduledAt?: Date | null;
  targets: TargetInput[];
  createdBy?: string;
}

export interface ScheduledPostView extends ScheduledPost {
  targets: (PublishTarget & { network: string; connectionName: string })[];
}

/** Validiert Optionen gegen das Schema des jeweiligen Netzwerks und legt Post + Ziele + Jobs an. */
export async function createScheduledPost(input: CreateScheduledPostInput): Promise<ScheduledPostView> {
  const db = await getDb();
  if (input.targets.length === 0) throw new Error("Mindestens ein Zielkonto auswählen.");
  if (!input.mediaId) throw new Error("Für Video-Posts ist eine Mediendatei nötig.");
  const media = await getMedia(input.mediaId);
  if (!media || media.brandId !== input.brandId) throw new Error("Mediendatei nicht gefunden.");
  const validated: { connectionId: string; options: Record<string, unknown> }[] = [];
  for (const t of input.targets) {
    const conn = await getConnection(t.connectionId);
    if (!conn || conn.brandId !== input.brandId) throw new Error(`Verbindung ${t.connectionId} gehört nicht zu dieser Brand.`);
    if (conn.status === "reauth_required") throw new Error(`${conn.name} (${conn.network}) muss neu verbunden werden.`);
    const parsed = connectorFor(conn.network).publishOptionsSchema.safeParse(t.options ?? {});
    if (!parsed.success) throw new Error(`Ungültige Optionen für ${conn.network}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`);
    validated.push({ connectionId: conn.id, options: parsed.data });
  }
  const scheduledAt = input.scheduledAt ?? new Date();
  const postId = crypto.randomUUID();
  await db.insert(schema.scheduledPosts).values({
    id: postId,
    brandId: input.brandId,
    mediaId: input.mediaId,
    text: input.text,
    title: input.title ?? null,
    scheduledAt,
    status: "scheduled",
    createdBy: input.createdBy ?? "ui",
  });
  for (const v of validated) {
    const targetId = crypto.randomUUID();
    await db.insert(schema.publishTargets).values({ id: targetId, scheduledPostId: postId, connectionId: v.connectionId, options: v.options });
    await enqueue("publish.target", { targetId }, { runAt: scheduledAt, uniqueKey: `publish:target:${targetId}`, maxAttempts: 3 });
  }
  return (await getScheduledPost(postId))!;
}

export async function getScheduledPost(id: string): Promise<ScheduledPostView | undefined> {
  const db = await getDb();
  const post = await db.query.scheduledPosts.findFirst({ where: eq(schema.scheduledPosts.id, id) });
  if (!post) return undefined;
  const targets = await db
    .select({ target: schema.publishTargets, network: schema.connections.network, connectionName: schema.connections.name })
    .from(schema.publishTargets)
    .innerJoin(schema.connections, eq(schema.publishTargets.connectionId, schema.connections.id))
    .where(eq(schema.publishTargets.scheduledPostId, id));
  return { ...post, targets: targets.map((t) => ({ ...t.target, network: t.network, connectionName: t.connectionName })) };
}

export async function listScheduledPosts(brandId: string, opts: { status?: ScheduledPost["status"]; limit?: number } = {}): Promise<ScheduledPostView[]> {
  const db = await getDb();
  const posts = await db.query.scheduledPosts.findMany({
    where: and(eq(schema.scheduledPosts.brandId, brandId), opts.status ? eq(schema.scheduledPosts.status, opts.status) : undefined),
    orderBy: desc(schema.scheduledPosts.scheduledAt),
    limit: opts.limit ?? 50,
  });
  if (posts.length === 0) return [];
  const targets = await db
    .select({ target: schema.publishTargets, network: schema.connections.network, connectionName: schema.connections.name })
    .from(schema.publishTargets)
    .innerJoin(schema.connections, eq(schema.publishTargets.connectionId, schema.connections.id))
    .where(
      inArray(
        schema.publishTargets.scheduledPostId,
        posts.map((p) => p.id),
      ),
    );
  return posts.map((p) => ({
    ...p,
    targets: targets.filter((t) => t.target.scheduledPostId === p.id).map((t) => ({ ...t.target, network: t.network, connectionName: t.connectionName })),
  }));
}

export async function cancelScheduledPost(id: string): Promise<void> {
  const db = await getDb();
  const post = await getScheduledPost(id);
  if (!post) throw new Error("Post nicht gefunden.");
  if (post.status === "published") throw new Error("Bereits veröffentlichte Posts können nicht storniert werden.");
  await db.update(schema.publishTargets).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(schema.publishTargets.scheduledPostId, id), eq(schema.publishTargets.status, "pending")));
  await db.update(schema.scheduledPosts).set({ status: "cancelled", updatedAt: new Date() }).where(eq(schema.scheduledPosts.id, id));
}

/** Wird vom Worker ausgeführt: veröffentlicht ein Ziel. */
export async function publishTarget(targetId: string): Promise<PublishResult | null> {
  const db = await getDb();
  const target = await db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, targetId) });
  if (!target || target.status === "cancelled" || target.status === "published") return null;
  const post = await db.query.scheduledPosts.findFirst({ where: eq(schema.scheduledPosts.id, target.scheduledPostId) });
  if (!post || post.status === "cancelled") return null;
  const conn = await getConnection(target.connectionId);
  if (!conn) throw new Error("Verbindung gelöscht.");
  const media = post.mediaId ? await getMedia(post.mediaId) : null;
  if (!media) throw new Error("Mediendatei fehlt.");

  await db.update(schema.publishTargets).set({ status: "publishing", attempts: target.attempts + 1, updatedAt: new Date() }).where(eq(schema.publishTargets.id, targetId));
  await db.update(schema.scheduledPosts).set({ status: "publishing", updatedAt: new Date() }).where(eq(schema.scheduledPosts.id, post.id));
  try {
    const ctx = await freshContext(conn);
    const filePath = await mediaLocalPath(media);
    const result = await connectorFor(conn.network).publishVideo(ctx, {
      filePath,
      publicUrl: mediaPublicUrl(media),
      mimeType: media.mimeType,
      sizeBytes: fs.statSync(filePath).size,
      text: post.text,
      title: post.title,
      options: target.options ?? {},
    });
    await applyResult(targetId, result);
    if (result.status === "processing") {
      await enqueue("publish.check", { targetId }, { runAt: new Date(Date.now() + 60_000), uniqueKey: `publish:check:${targetId}`, maxAttempts: 40 });
    }
    await refreshPostStatus(post.id);
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await db.update(schema.publishTargets).set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() }).where(eq(schema.publishTargets.id, targetId));
    await refreshPostStatus(post.id);
    const { retry } = await handleConnectorError(conn, err);
    const e = err instanceof Error ? err : new Error(String(err));
    (e as Error & { retry?: boolean }).retry = retry && target.attempts + 1 < 3;
    throw e;
  }
}

export async function checkTarget(targetId: string): Promise<"published" | "processing" | "skipped"> {
  const db = await getDb();
  const target = await db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, targetId) });
  if (!target || target.status !== "processing" || !target.externalId) return "skipped";
  const conn = await getConnection(target.connectionId);
  if (!conn) return "skipped";
  const connector = connectorFor(conn.network);
  if (!connector.checkPublishStatus) {
    await applyResult(targetId, { externalId: target.externalId, permalink: target.permalink, status: "published" });
    await refreshPostStatus(target.scheduledPostId);
    return "published";
  }
  try {
    const ctx = await freshContext(conn);
    const result = await connector.checkPublishStatus(ctx, { externalId: target.externalId, permalink: target.permalink, status: "processing", raw: target.raw });
    await applyResult(targetId, result);
    await refreshPostStatus(target.scheduledPostId);
    return result.status;
  } catch (err) {
    await db
      .update(schema.publishTargets)
      .set({ status: "failed", error: ((err as Error).message ?? String(err)).slice(0, 2000), updatedAt: new Date() })
      .where(eq(schema.publishTargets.id, targetId));
    await refreshPostStatus(target.scheduledPostId);
    throw err;
  }
}

async function applyResult(targetId: string, result: PublishResult) {
  const db = await getDb();
  await db
    .update(schema.publishTargets)
    .set({
      status: result.status === "published" ? "published" : "processing",
      externalId: result.externalId,
      permalink: result.permalink ?? null,
      raw: result.raw ?? null,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.publishTargets.id, targetId));
}

export async function refreshPostStatus(postId: string) {
  const db = await getDb();
  const targets = await db.query.publishTargets.findMany({ where: eq(schema.publishTargets.scheduledPostId, postId) });
  const statuses = targets.map((t) => t.status);
  let status: ScheduledPost["status"];
  if (statuses.every((s) => s === "cancelled")) status = "cancelled";
  else if (statuses.every((s) => s === "published" || s === "cancelled")) status = "published";
  else if (statuses.every((s) => s === "failed" || s === "cancelled")) status = "failed";
  else if (statuses.some((s) => s === "publishing" || s === "processing")) status = "publishing";
  else if (statuses.some((s) => s === "failed") && statuses.some((s) => s === "published")) status = "partial";
  else if (statuses.some((s) => s === "failed")) status = "partial";
  else status = "scheduled";
  await db.update(schema.scheduledPosts).set({ status, updatedAt: new Date() }).where(eq(schema.scheduledPosts.id, postId));
}
