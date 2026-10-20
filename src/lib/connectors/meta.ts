import { z } from "zod";
import { env } from "../env";
import { ConnectorHttpError, daysBetween, fetchJson, isoDate, qs, unix } from "./http";
import type {
  AccountCandidate,
  AudienceRow,
  ConnectionContext,
  Connector,
  MetricPoint,
  PostRecord,
  PublishInput,
  PublishResult,
  SyncRange,
} from "./types";

/**
 * Meta Graph API: Facebook-Seiten und Instagram-Business-Konten über
 * "Instagram API with Facebook Login". Ein OAuth-Login liefert alle Seiten
 * des Nutzers samt verknüpfter Instagram-Konten. Page-Tokens, die aus einem
 * Long-lived-User-Token stammen, laufen nicht ab.
 */

const graph = () => `https://graph.facebook.com/${env().META_GRAPH_VERSION}`;

export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "pages_manage_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "instagram_content_publish",
  "instagram_manage_comments",
  "business_management",
];

function configured() {
  const e = env();
  return !!(e.META_APP_ID && e.META_APP_SECRET);
}

function authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
  const e = env();
  const params: Record<string, string> = {
    client_id: e.META_APP_ID!,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  };
  if (e.META_CONFIG_ID) {
    params.config_id = e.META_CONFIG_ID; // Facebook Login for Business
    params.override_default_response_type = "true";
  } else {
    params.scope = META_SCOPES.join(",");
  }
  return `https://www.facebook.com/${e.META_GRAPH_VERSION}/dialog/oauth?${qs(params)}`;
}

interface Paged<T> {
  data: T[];
  paging?: { next?: string };
}

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
    followers_count?: number;
  };
}

async function exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<AccountCandidate[]> {
  const e = env();
  const short = await fetchJson<{ access_token: string }>(
    `${graph()}/oauth/access_token?${qs({ client_id: e.META_APP_ID, client_secret: e.META_APP_SECRET, redirect_uri: redirectUri, code })}`,
  );
  const long = await fetchJson<{ access_token: string; expires_in?: number }>(
    `${graph()}/oauth/access_token?${qs({
      grant_type: "fb_exchange_token",
      client_id: e.META_APP_ID,
      client_secret: e.META_APP_SECRET,
      fb_exchange_token: short.access_token,
    })}`,
  );
  const userToken = long.access_token;
  const userTokenExpiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
  const me = await fetchJson<{ id: string; name?: string }>(`${graph()}/me?${qs({ fields: "id,name", access_token: userToken })}`);

  const pages: FbPage[] = [];
  let url: string | null = `${graph()}/me/accounts?${qs({
    fields: "id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url,followers_count}",
    limit: 100,
    access_token: userToken,
  })}`;
  while (url) {
    const page: Paged<FbPage> = await fetchJson(url);
    pages.push(...(page.data ?? []));
    url = page.paging?.next ?? null;
  }

  const out: AccountCandidate[] = [];
  for (const p of pages) {
    const base = { userId: me.id, pageId: p.id, userTokenExpiresAt, connectionType: "facebook_login" };
    out.push({
      network: "facebook",
      externalId: p.id,
      name: p.name,
      pictureUrl: p.picture?.data?.url ?? null,
      tokens: { accessToken: p.access_token, expiresAt: null, scopes: META_SCOPES },
      meta: base,
    });
    const ig = p.instagram_business_account;
    if (ig) {
      out.push({
        network: "instagram",
        externalId: ig.id,
        name: ig.name ?? ig.username ?? ig.id,
        username: ig.username ?? null,
        pictureUrl: ig.profile_picture_url ?? null,
        tokens: { accessToken: p.access_token, expiresAt: null, scopes: META_SCOPES },
        meta: { ...base, pageName: p.name },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

interface InsightValue {
  value: number | Record<string, number>;
  end_time?: string;
}
interface InsightEntry {
  name: string;
  period?: string;
  values?: InsightValue[];
  total_value?: { value?: number; breakdowns?: { dimension_keys: string[]; results: { dimension_values: string[]; value: number }[] }[] };
}

/**
 * Insights-Aufruf, der nicht unterstützte Metriken (Meta ändert die Liste laufend)
 * aus der Fehlermeldung herausliest, entfernt und erneut versucht.
 */
async function insights(objectId: string, token: string, metrics: string[], params: Record<string, string | number | undefined>): Promise<InsightEntry[]> {
  let remaining = [...metrics];
  for (let i = 0; i < metrics.length && remaining.length > 0; i++) {
    try {
      const res = await fetchJson<{ data: InsightEntry[] }>(
        `${graph()}/${objectId}/insights?${qs({ metric: remaining.join(","), access_token: token, ...params })}`,
        { retries: 2 },
      );
      return res.data ?? [];
    } catch (err) {
      if (!(err instanceof ConnectorHttpError) || err.status !== 400) throw err;
      const msg = JSON.stringify(err.body);
      const bad = remaining.find((m) => new RegExp(`[^a-z_]${m}[^a-z_]`).test(msg));
      if (!bad) throw err;
      remaining = remaining.filter((m) => m !== bad);
    }
  }
  return [];
}

/**
 * Metas `end_time` (z. B. "2026-10-02T07:00:00+0000") markiert das Ende des
 * Pacific-Tages, dessen Wert geliefert wird. 12 Stunden zurück → Kalendertag.
 */
function metaDay(endTime: string): string {
  return isoDate(new Date(new Date(endTime).getTime() - 12 * 60 * 60 * 1000));
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  if (v && typeof v === "object") return Object.values(v as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0);
  return 0;
}

function windows(range: SyncRange, days: number): SyncRange[] {
  const out: SyncRange[] = [];
  let start = new Date(range.since);
  while (start <= range.until) {
    const end = new Date(Math.min(range.until.getTime(), start.getTime() + days * 86_400_000 - 1));
    out.push({ since: start, until: end });
    start = new Date(end.getTime() + 1);
  }
  return out;
}

function dayBounds(day: string): { since: number; until: number } {
  const s = new Date(`${day}T00:00:00Z`);
  return { since: unix(s), until: unix(new Date(s.getTime() + 86_400_000)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Instagram                                                           */
/* ------------------------------------------------------------------ */

const IG_DAILY_TOTAL_METRICS = [
  "views",
  "accounts_engaged",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profile_views",
  "website_clicks",
  "profile_links_taps",
];

async function igSyncAccount(ctx: ConnectionContext, range: SyncRange): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  const today = isoDate(new Date());

  const snap = await fetchJson<{ followers_count?: number; follows_count?: number; media_count?: number }>(
    `${graph()}/${ctx.externalId}?${qs({ fields: "followers_count,follows_count,media_count", access_token: ctx.accessToken })}`,
  );
  points.push({ metric: "followers", date: today, value: snap.followers_count ?? 0 });
  points.push({ metric: "following", date: today, value: snap.follows_count ?? 0 });
  points.push({ metric: "media_count", date: today, value: snap.media_count ?? 0 });

  // Zeitreihen (max. 30 Tage pro Aufruf)
  for (const w of windows(range, 30)) {
    const data = await insights(ctx.externalId, ctx.accessToken, ["reach", "follower_count"], {
      period: "day",
      since: unix(w.since),
      until: unix(w.until),
    });
    for (const entry of data) {
      const key = entry.name === "follower_count" ? "followers_change" : entry.name;
      for (const v of entry.values ?? []) {
        if (!v.end_time) continue;
        points.push({ metric: key, date: metaDay(v.end_time), value: num(v.value) });
      }
    }
  }

  // Tages-Totale (ein Aufruf pro Tag)
  for (const day of daysBetween(range.since, range.until)) {
    const b = dayBounds(day);
    const data = await insights(ctx.externalId, ctx.accessToken, IG_DAILY_TOTAL_METRICS, {
      period: "day",
      metric_type: "total_value",
      since: b.since,
      until: b.until,
    });
    for (const entry of data) {
      const value = entry.total_value?.value ?? (entry.values?.[0] ? num(entry.values[0].value) : undefined);
      if (value === undefined) continue;
      points.push({ metric: entry.name, date: day, value });
    }
  }
  return points;
}

interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

const IG_MEDIA_METRICS: Record<string, string[]> = {
  REELS: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"],
  FEED: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "profile_visits", "follows"],
  STORY: ["views", "reach", "replies", "shares", "total_interactions", "navigation"],
};

const IG_METRIC_RENAME: Record<string, string> = {
  saved: "saves",
  ig_reels_avg_watch_time: "avg_watch_time_ms",
  ig_reels_video_view_total_time: "total_watch_time_ms",
};

async function igMediaMetrics(media: IgMedia, token: string): Promise<Record<string, number>> {
  const product = (media.media_product_type ?? "FEED").toUpperCase();
  const list = IG_MEDIA_METRICS[product] ?? IG_MEDIA_METRICS.FEED;
  const metrics: Record<string, number> = {};
  if (typeof media.like_count === "number") metrics.likes = media.like_count;
  if (typeof media.comments_count === "number") metrics.comments = media.comments_count;
  try {
    const data = await insights(media.id, token, list, {});
    for (const entry of data) {
      const key = IG_METRIC_RENAME[entry.name] ?? entry.name;
      const v = entry.values?.[0]?.value ?? entry.total_value?.value;
      if (v !== undefined) metrics[key] = num(v);
    }
  } catch (err) {
    // Einzelne Medien (z. B. vor der Verbindung veröffentlicht) liefern keine Insights.
    if (!(err instanceof ConnectorHttpError && err.status === 400)) throw err;
  }
  return metrics;
}

async function igSyncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  const out: PostRecord[] = [];
  const fields = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  let url: string | null = `${graph()}/${ctx.externalId}/media?${qs({ fields, limit: 50, access_token: ctx.accessToken })}`;
  let stop = false;
  while (url && !stop) {
    const page: Paged<IgMedia> = await fetchJson(url);
    for (const m of page.data ?? []) {
      const published = new Date(m.timestamp);
      if (published < range.since) {
        stop = true;
        break;
      }
      if (published > range.until) continue;
      out.push({
        externalId: m.id,
        type: (m.media_product_type ?? m.media_type ?? "FEED").toLowerCase(),
        caption: m.caption ?? null,
        permalink: m.permalink ?? null,
        mediaUrl: m.media_url ?? null,
        thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
        publishedAt: published,
        raw: m,
        metrics: await igMediaMetrics(m, ctx.accessToken),
      });
    }
    url = page.paging?.next ?? null;
  }
  // Aktive Stories (nur 24 h abrufbar)
  try {
    const stories = await fetchJson<{ data: IgMedia[] }>(
      `${graph()}/${ctx.externalId}/stories?${qs({ fields, access_token: ctx.accessToken })}`,
    );
    for (const s of stories.data ?? []) {
      out.push({
        externalId: s.id,
        type: "story",
        caption: s.caption ?? null,
        permalink: s.permalink ?? null,
        mediaUrl: s.media_url ?? null,
        thumbnailUrl: s.thumbnail_url ?? s.media_url ?? null,
        publishedAt: new Date(s.timestamp),
        raw: s,
        metrics: await igMediaMetrics({ ...s, media_product_type: "STORY" }, ctx.accessToken),
      });
    }
  } catch {
    /* Stories optional */
  }
  return out;
}

async function igSyncAudience(ctx: ConnectionContext): Promise<AudienceRow[]> {
  const rows: AudienceRow[] = [];
  const combos: { metric: string; breakdown: string; dimension: string }[] = [
    { metric: "follower_demographics", breakdown: "age,gender", dimension: "age_gender" },
    { metric: "follower_demographics", breakdown: "country", dimension: "country" },
    { metric: "follower_demographics", breakdown: "city", dimension: "city" },
    { metric: "engaged_audience_demographics", breakdown: "age,gender", dimension: "engaged_age_gender" },
    { metric: "engaged_audience_demographics", breakdown: "country", dimension: "engaged_country" },
  ];
  for (const c of combos) {
    try {
      const data = await insights(ctx.externalId, ctx.accessToken, [c.metric], {
        period: "lifetime",
        metric_type: "total_value",
        breakdown: c.breakdown,
      });
      for (const entry of data) {
        for (const bd of entry.total_value?.breakdowns ?? []) {
          for (const r of bd.results ?? []) {
            const key = normalizeDemographicKey(bd.dimension_keys, r.dimension_values);
            rows.push({ dimension: c.dimension, key, value: r.value });
          }
        }
      }
    } catch (err) {
      // Demografie erfordert ≥ 100 Follower; Meta antwortet dann mit 400.
      if (!(err instanceof ConnectorHttpError && err.status === 400)) throw err;
    }
  }
  return rows;
}

function normalizeDemographicKey(keys: string[], values: string[]): string {
  const map: Record<string, string> = {};
  keys.forEach((k, i) => (map[k] = values[i]));
  if (map.age && map.gender) return `${map.age}|${normalizeGender(map.gender)}`;
  return values.join("|");
}

export function normalizeGender(g: string): string {
  const s = g.toLowerCase();
  if (s.startsWith("f")) return "F";
  if (s.startsWith("m")) return "M";
  return "U";
}

const igPublishOptions = z.object({
  kind: z.enum(["reel", "story"]).default("reel").describe("Reel (Feed/Reels-Tab) oder Story"),
  shareToFeed: z.boolean().default(true).describe("Reel zusätzlich im Feed zeigen"),
  coverUrl: z.string().url().optional().describe("Öffentliche URL eines Cover-Bildes"),
  thumbOffsetMs: z.number().int().min(0).optional().describe("Frame für das Cover in Millisekunden"),
  collaborators: z.array(z.string()).max(3).optional().describe("Instagram-Usernames für Collab-Post"),
  locationId: z.string().optional().describe("Facebook-Page-ID des Ortes"),
});

async function igPublishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = igPublishOptions.parse(input.options ?? {});
  const body: Record<string, string> = {
    media_type: o.kind === "story" ? "STORIES" : "REELS",
    video_url: input.publicUrl,
    access_token: ctx.accessToken,
  };
  if (o.kind === "reel") {
    body.caption = input.text;
    body.share_to_feed = String(o.shareToFeed);
    if (o.coverUrl) body.cover_url = o.coverUrl;
    if (o.thumbOffsetMs !== undefined) body.thumb_offset = String(o.thumbOffsetMs);
    if (o.collaborators?.length) body.collaborators = JSON.stringify(o.collaborators);
    if (o.locationId) body.location_id = o.locationId;
  }
  const container = await fetchJson<{ id: string }>(`${graph()}/${ctx.externalId}/media`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    retries: 1,
  });
  return igFinishPublish(ctx, container.id, 24);
}

async function igFinishPublish(ctx: ConnectionContext, containerId: string, maxPolls: number): Promise<PublishResult> {
  for (let i = 0; i < maxPolls; i++) {
    const status = await fetchJson<{ status_code?: string; status?: string }>(
      `${graph()}/${containerId}?${qs({ fields: "status_code,status", access_token: ctx.accessToken })}`,
    );
    if (status.status_code === "FINISHED") {
      const published = await fetchJson<{ id: string }>(`${graph()}/${ctx.externalId}/media_publish`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: containerId, access_token: ctx.accessToken }).toString(),
        retries: 1,
      });
      let permalink: string | null = null;
      try {
        const m = await fetchJson<{ permalink?: string }>(`${graph()}/${published.id}?${qs({ fields: "permalink", access_token: ctx.accessToken })}`);
        permalink = m.permalink ?? null;
      } catch {
        /* optional */
      }
      return { externalId: published.id, permalink, status: "published", raw: { containerId } };
    }
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Instagram-Container ${status.status_code}: ${status.status ?? "unbekannter Fehler"}`);
    }
    await sleep(5000);
  }
  return { externalId: containerId, status: "processing", raw: { containerId } };
}

/* ------------------------------------------------------------------ */
/* Facebook-Seite                                                      */
/* ------------------------------------------------------------------ */

const FB_PAGE_METRICS = [
  "page_impressions",
  "page_impressions_unique",
  "page_post_engagements",
  "page_fans",
  "page_fan_adds",
  "page_fan_removes",
  "page_views_total",
  "page_video_views",
  "page_follows",
  "page_daily_follows",
  "page_daily_unfollows",
];
const FB_RENAME: Record<string, string> = {
  page_impressions: "impressions",
  page_impressions_unique: "reach",
  page_post_engagements: "post_engagements",
  page_fans: "likes_total",
  page_fan_adds: "likes_gained",
  page_fan_removes: "likes_lost",
  page_views_total: "page_views",
  page_video_views: "video_views",
  page_follows: "followers",
  page_daily_follows: "followers_gained",
  page_daily_unfollows: "followers_lost",
};

async function fbSyncAccount(ctx: ConnectionContext, range: SyncRange): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  const today = isoDate(new Date());
  const snap = await fetchJson<{ fan_count?: number; followers_count?: number }>(
    `${graph()}/${ctx.externalId}?${qs({ fields: "fan_count,followers_count", access_token: ctx.accessToken })}`,
  );
  points.push({ metric: "followers", date: today, value: snap.followers_count ?? 0 });
  points.push({ metric: "likes_total", date: today, value: snap.fan_count ?? 0 });
  for (const w of windows(range, 90)) {
    const data = await insights(ctx.externalId, ctx.accessToken, FB_PAGE_METRICS, { period: "day", since: unix(w.since), until: unix(w.until) });
    for (const entry of data) {
      const key = FB_RENAME[entry.name] ?? entry.name;
      for (const v of entry.values ?? []) {
        if (!v.end_time) continue;
        const date = metaDay(v.end_time);
        if (key === "followers" && date === today) continue; // Snapshot ist genauer
        points.push({ metric: key, date, value: num(v.value) });
      }
    }
  }
  return points;
}

interface FbPost {
  id: string;
  message?: string;
  story?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: { data?: { media_type?: string; type?: string; media?: { source?: string } }[] };
  shares?: { count?: number };
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
}

const FB_POST_METRICS = ["post_impressions", "post_impressions_unique", "post_engaged_users", "post_clicks", "post_reactions_by_type_total", "post_video_views"];
const FB_POST_RENAME: Record<string, string> = {
  post_impressions: "impressions",
  post_impressions_unique: "reach",
  post_engaged_users: "engaged_users",
  post_clicks: "clicks",
  post_reactions_by_type_total: "reactions",
  post_video_views: "video_views",
};

async function fbSyncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  const out: PostRecord[] = [];
  const fields =
    "id,message,story,created_time,permalink_url,full_picture,attachments{media_type,type,media},shares,likes.summary(true).limit(0),comments.summary(true).limit(0)";
  let url: string | null = `${graph()}/${ctx.externalId}/posts?${qs({
    fields,
    limit: 50,
    since: unix(range.since),
    until: unix(range.until),
    access_token: ctx.accessToken,
  })}`;
  while (url) {
    const page: Paged<FbPost> = await fetchJson(url);
    for (const p of page.data ?? []) {
      const metrics: Record<string, number> = {
        likes: p.likes?.summary?.total_count ?? 0,
        comments: p.comments?.summary?.total_count ?? 0,
        shares: p.shares?.count ?? 0,
      };
      try {
        const data = await insights(p.id, ctx.accessToken, FB_POST_METRICS, {});
        for (const entry of data) {
          const key = FB_POST_RENAME[entry.name] ?? entry.name;
          const v = entry.values?.[0]?.value;
          if (v !== undefined) metrics[key] = num(v);
        }
      } catch (err) {
        if (!(err instanceof ConnectorHttpError && err.status === 400)) throw err;
      }
      const att = p.attachments?.data?.[0];
      out.push({
        externalId: p.id,
        type: (att?.media_type ?? att?.type ?? "status").toLowerCase(),
        caption: p.message ?? p.story ?? null,
        permalink: p.permalink_url ?? null,
        mediaUrl: att?.media?.source ?? null,
        thumbnailUrl: p.full_picture ?? null,
        publishedAt: new Date(p.created_time),
        raw: p,
        metrics,
      });
    }
    url = page.paging?.next ?? null;
  }
  return out;
}

async function fbSyncAudience(ctx: ConnectionContext): Promise<AudienceRow[]> {
  const rows: AudienceRow[] = [];
  const combos: { metric: string; dimension: string }[] = [
    { metric: "page_fans_country", dimension: "country" },
    { metric: "page_fans_city", dimension: "city" },
    { metric: "page_fans_gender_age", dimension: "age_gender" },
    { metric: "page_fans_locale", dimension: "locale" },
  ];
  for (const c of combos) {
    try {
      const data = await insights(ctx.externalId, ctx.accessToken, [c.metric], { period: "lifetime" });
      const last = data[0]?.values?.at(-1)?.value;
      if (!last || typeof last !== "object") continue;
      for (const [k, v] of Object.entries(last)) {
        let key = k;
        if (c.dimension === "age_gender") {
          const [g, age] = k.split(".");
          key = `${age}|${normalizeGender(g)}`;
        }
        rows.push({ dimension: c.dimension, key, value: Number(v) || 0 });
      }
    } catch (err) {
      if (!(err instanceof ConnectorHttpError && err.status === 400)) throw err;
    }
  }
  return rows;
}

const fbPublishOptions = z.object({
  kind: z.enum(["video", "reel"]).default("reel").describe("Normales Video oder Facebook-Reel"),
  title: z.string().max(255).optional(),
});

async function fbPublishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = fbPublishOptions.parse(input.options ?? {});
  if (o.kind === "video") {
    const res = await fetchJson<{ id: string }>(`${graph()}/${ctx.externalId}/videos`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        file_url: input.publicUrl,
        description: input.text,
        ...(o.title ?? input.title ? { title: o.title ?? input.title ?? "" } : {}),
        access_token: ctx.accessToken,
      }).toString(),
      retries: 1,
    });
    return { externalId: res.id, permalink: `https://www.facebook.com/${ctx.externalId}/videos/${res.id}`, status: "processing", raw: res };
  }
  // Reel: 3-Phasen-Upload
  const start = await fetchJson<{ video_id: string; upload_url: string }>(`${graph()}/${ctx.externalId}/video_reels`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ upload_phase: "start", access_token: ctx.accessToken }).toString(),
    retries: 1,
  });
  await fetchJson(start.upload_url, {
    method: "POST",
    headers: { Authorization: `OAuth ${ctx.accessToken}`, file_url: input.publicUrl },
    retries: 1,
  });
  const finish = await fetchJson<{ success?: boolean; post_id?: string }>(`${graph()}/${ctx.externalId}/video_reels`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      upload_phase: "finish",
      video_id: start.video_id,
      video_state: "PUBLISHED",
      description: input.text,
      ...(o.title ?? input.title ? { title: o.title ?? input.title ?? "" } : {}),
      access_token: ctx.accessToken,
    }).toString(),
    retries: 1,
  });
  return {
    externalId: start.video_id,
    permalink: `https://www.facebook.com/reel/${start.video_id}`,
    status: "processing",
    raw: { ...finish, videoId: start.video_id },
  };
}

async function fbCheckPublishStatus(ctx: ConnectionContext, result: PublishResult): Promise<PublishResult> {
  const v = await fetchJson<{ status?: { video_status?: string; publishing_phase?: { status?: string } }; permalink_url?: string }>(
    `${graph()}/${result.externalId}?${qs({ fields: "status,permalink_url", access_token: ctx.accessToken })}`,
  );
  const st = v.status?.video_status;
  const done = st === "ready" || v.status?.publishing_phase?.status === "complete";
  const permalink = v.permalink_url ? (v.permalink_url.startsWith("http") ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : result.permalink;
  if (st === "error") throw new Error("Facebook meldet einen Verarbeitungsfehler für das Video.");
  return { ...result, permalink, status: done ? "published" : "processing" };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const shared = {
  provider: "meta" as const,
  scopes: META_SCOPES,
  configured,
  authorizationUrl,
  exchangeCode,
  refreshTokens: async () => null, // Page-Tokens laufen nicht ab
};

export const instagramConnector: Connector = {
  ...shared,
  network: "instagram",
  label: "Instagram",
  syncAccount: igSyncAccount,
  syncPosts: igSyncPosts,
  syncAudience: igSyncAudience,
  publishVideo: igPublishVideo,
  checkPublishStatus: async (ctx, r) => {
    const containerId = (r.raw as { containerId?: string } | undefined)?.containerId ?? r.externalId;
    return igFinishPublish(ctx, containerId, 6);
  },
  publishOptionsSchema: igPublishOptions,
  accountMetrics: [
    { key: "followers", label: "Follower", aggregation: "last" },
    { key: "following", label: "Folgt", aggregation: "last" },
    { key: "followers_change", label: "Follower-Veränderung", aggregation: "sum" },
    { key: "reach", label: "Reichweite", aggregation: "sum" },
    { key: "views", label: "Views", aggregation: "sum" },
    { key: "accounts_engaged", label: "Interagierende Konten", aggregation: "sum" },
    { key: "total_interactions", label: "Interaktionen", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "saves", label: "Gespeichert", aggregation: "sum" },
    { key: "profile_views", label: "Profilaufrufe", aggregation: "sum" },
    { key: "website_clicks", label: "Website-Klicks", aggregation: "sum" },
    { key: "profile_links_taps", label: "Profil-Link-Taps", aggregation: "sum" },
  ],
  postMetrics: [
    { key: "views", label: "Views", aggregation: "sum" },
    { key: "reach", label: "Reichweite", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "saves", label: "Gespeichert", aggregation: "sum" },
    { key: "total_interactions", label: "Interaktionen", aggregation: "sum" },
    { key: "avg_watch_time_ms", label: "Ø Wiedergabezeit (ms)", aggregation: "avg" },
    { key: "total_watch_time_ms", label: "Gesamt-Wiedergabezeit (ms)", aggregation: "sum" },
    { key: "profile_visits", label: "Profilbesuche", aggregation: "sum" },
    { key: "follows", label: "Neue Follower", aggregation: "sum" },
    { key: "replies", label: "Antworten", aggregation: "sum" },
  ],
  audienceDimensions: ["age_gender", "country", "city", "engaged_age_gender", "engaged_country"],
  notes: [
    "Benötigt ein Instagram-Business- oder Creator-Konto, das mit einer Facebook-Seite verknüpft ist.",
    "Demografie-Daten liefert Meta erst ab 100 Followern.",
    "Reels werden per öffentlicher Video-URL geholt: APP_URL muss von außen erreichbar sein.",
    "Maximal 25 API-Veröffentlichungen pro 24 Stunden.",
  ],
};

export const facebookConnector: Connector = {
  ...shared,
  network: "facebook",
  label: "Facebook-Seite",
  syncAccount: fbSyncAccount,
  syncPosts: fbSyncPosts,
  syncAudience: fbSyncAudience,
  publishVideo: fbPublishVideo,
  checkPublishStatus: fbCheckPublishStatus,
  publishOptionsSchema: fbPublishOptions,
  accountMetrics: [
    { key: "followers", label: "Follower", aggregation: "last" },
    { key: "likes_total", label: "Gefällt mir (gesamt)", aggregation: "last" },
    { key: "impressions", label: "Impressionen", aggregation: "sum" },
    { key: "reach", label: "Reichweite", aggregation: "sum" },
    { key: "post_engagements", label: "Beitragsinteraktionen", aggregation: "sum" },
    { key: "page_views", label: "Seitenaufrufe", aggregation: "sum" },
    { key: "video_views", label: "Videoaufrufe", aggregation: "sum" },
    { key: "followers_gained", label: "Neue Follower", aggregation: "sum" },
    { key: "followers_lost", label: "Verlorene Follower", aggregation: "sum" },
    { key: "likes_gained", label: "Neue Gefällt-mir", aggregation: "sum" },
    { key: "likes_lost", label: "Verlorene Gefällt-mir", aggregation: "sum" },
  ],
  postMetrics: [
    { key: "impressions", label: "Impressionen", aggregation: "sum" },
    { key: "reach", label: "Reichweite", aggregation: "sum" },
    { key: "engaged_users", label: "Interagierende Nutzer", aggregation: "sum" },
    { key: "clicks", label: "Klicks", aggregation: "sum" },
    { key: "reactions", label: "Reaktionen", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "video_views", label: "Videoaufrufe", aggregation: "sum" },
  ],
  audienceDimensions: ["country", "city", "age_gender", "locale"],
  notes: [
    "Seiten-Insights brauchen die Rolle 'Vollzugriff' auf der Seite.",
    "Einige Demografie-Metriken hat Meta 2024/2025 eingestellt; dann bleibt der Bereich leer.",
  ],
};
