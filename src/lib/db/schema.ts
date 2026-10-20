import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const NETWORKS = ["facebook", "instagram", "youtube", "tiktok", "linkedin", "x"] as const;
export type Network = (typeof NETWORKS)[number];

const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Eine Brand = ein Kunde / ein Projekt mit beliebig vielen verbundenen Konten. */
export const brands = pgTable("brands", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("Europe/Vienna"),
  createdAt: createdAt(),
});

/** Ein verbundenes Social-Konto (Facebook-Seite, IG-Business-Konto, YouTube-Kanal, ...). */
export const connections = pgTable(
  "connections",
  {
    id: id(),
    brandId: text("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
    network: text("network").$type<Network>().notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    username: text("username"),
    pictureUrl: text("picture_url"),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    status: text("status").$type<"active" | "reauth_required" | "error" | "disconnected">().notNull().default("active"),
    statusMessage: text("status_message"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("connections_brand_network_external").on(t.brandId, t.network, t.externalId)],
);

/** Tages-Zeitreihe pro Konto und Metrik (Follower, Views, Reach, ...). */
export const metricDaily = pgTable(
  "metric_daily",
  {
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    date: date("date").notNull(),
    value: doublePrecision("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("metric_daily_pk").on(t.connectionId, t.metric, t.date),
    index("metric_daily_conn_date").on(t.connectionId, t.date),
  ],
);

/** Veröffentlichte Inhalte des Kontos (Posts, Reels, Videos, Tweets). */
export const posts = pgTable(
  "posts",
  {
    id: id(),
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    title: text("title"),
    caption: text("caption"),
    permalink: text("permalink"),
    mediaUrl: text("media_url"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<unknown>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("posts_conn_external").on(t.connectionId, t.externalId),
    index("posts_conn_published").on(t.connectionId, t.publishedAt),
  ],
);

/** Tages-Snapshots der Post-Metriken (Views, Likes, Kommentare, Shares, Saves, Watchtime ...). */
export const postMetrics = pgTable(
  "post_metrics",
  {
    postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    date: date("date").notNull(),
    value: doublePrecision("value").notNull(),
  },
  (t) => [uniqueIndex("post_metrics_pk").on(t.postId, t.metric, t.date)],
);

/** Zielgruppen-Verteilungen (Alter/Geschlecht, Land, Stadt, Traffic-Quelle, Gerät ...). */
export const audience = pgTable(
  "audience",
  {
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    key: text("key").notNull(),
    value: doublePrecision("value").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("audience_pk").on(t.connectionId, t.dimension, t.key)],
);

/** Hochgeladene Medien (Videos), lokal oder in S3. */
export const media = pgTable("media", {
  id: id(),
  brandId: text("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  durationSeconds: doublePrecision("duration_seconds"),
  width: integer("width"),
  height: integer("height"),
  createdAt: createdAt(),
});

export type ScheduledPostStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled";

/** Ein geplanter Beitrag, der auf ein oder mehrere Konten geht. */
export const scheduledPosts = pgTable(
  "scheduled_posts",
  {
    id: id(),
    brandId: text("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
    mediaId: text("media_id").references(() => media.id, { onDelete: "set null" }),
    text: text("text").notNull().default(""),
    title: text("title"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").$type<ScheduledPostStatus>().notNull().default("scheduled"),
    createdBy: text("created_by").notNull().default("ui"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduled_posts_brand_status").on(t.brandId, t.status)],
);

export type PublishTargetStatus = "pending" | "publishing" | "processing" | "published" | "failed" | "cancelled";

/** Ein Ziel-Konto eines geplanten Beitrags inkl. netzwerkspezifischer Optionen und Ergebnis. */
export const publishTargets = pgTable(
  "publish_targets",
  {
    id: id(),
    scheduledPostId: text("scheduled_post_id").notNull().references(() => scheduledPosts.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<PublishTargetStatus>().notNull().default("pending"),
    externalId: text("external_id"),
    permalink: text("permalink"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    raw: jsonb("raw").$type<unknown>(),
    updatedAt: updatedAt(),
  },
  (t) => [index("publish_targets_post").on(t.scheduledPostId)],
);

/** Gespeicherte Reports (Markdown), z. B. von Claude über MCP geschrieben. */
export const reports = pgTable("reports", {
  id: id(),
  brandId: text("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  markdown: text("markdown").notNull(),
  periodFrom: date("period_from"),
  periodTo: date("period_to"),
  createdBy: text("created_by").notNull().default("ui"),
  createdAt: createdAt(),
});

/** API-Keys für den MCP-Server / die REST-API. Nur der Hash wird gespeichert. */
export const apiKeys = pgTable("api_keys", {
  id: id(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Kurzlebiger OAuth-State (CSRF-Schutz + PKCE-Verifier). */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  brandId: text("brand_id").notNull(),
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier"),
  returnTo: text("return_to"),
  createdAt: createdAt(),
});

/** Nach dem OAuth-Login zwischengespeicherte Konto-Kandidaten (verschlüsselt), bis der Nutzer auswählt. */
export const oauthCandidates = pgTable("oauth_candidates", {
  id: id(),
  brandId: text("brand_id").notNull(),
  provider: text("provider").notNull(),
  payloadEnc: text("payload_enc").notNull(),
  createdAt: createdAt(),
});

export type JobStatus = "queued" | "running" | "done" | "failed";

/** DB-basierte Job-Queue (Sync, Token-Refresh, Publishing). */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    uniqueKey: text("unique_key"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result").$type<unknown>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_run_at").on(t.status, t.runAt), uniqueIndex("jobs_unique_key").on(t.uniqueKey)],
);

export const syncLogs = pgTable(
  "sync_logs",
  {
    id: id(),
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    ok: boolean("ok").notNull(),
    message: text("message"),
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("sync_logs_conn").on(t.connectionId, t.createdAt)],
);

export type Brand = typeof brands.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Media = typeof media.$inferSelect;
export type ScheduledPost = typeof scheduledPosts.$inferSelect;
export type PublishTarget = typeof publishTargets.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Job = typeof jobs.$inferSelect;
