import fs from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { env } from "../env";
import { ConnectorHttpError, fetchJson, formBody, isoDate, qs } from "./http";
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
  TokenSet,
} from "./types";

/**
 * YouTube: Data API v3 (Kanal, Videos, Upload) + YouTube Analytics API v2
 * (Tageswerte, Demografie, Geografie, Traffic-Quellen). Google-Tokens laufen
 * nach 1 h ab und werden über das Refresh-Token erneuert.
 */

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";

function configured() {
  const e = env();
  return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

function authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs({
    client_id: env().GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  })}`;
}

interface GoogleToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<GoogleToken> {
  const e = env();
  return fetchJson<GoogleToken>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, ...params }),
    retries: 1,
  });
}

function auth(ctx: { accessToken: string }) {
  return { Authorization: `Bearer ${ctx.accessToken}` };
}

interface Channel {
  id: string;
  snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url?: string }; medium?: { url?: string } } };
  statistics?: { viewCount?: string; subscriberCount?: string; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

async function exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<AccountCandidate[]> {
  const tok = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  const tokens: TokenSet = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    scopes: tok.scope?.split(" ") ?? YOUTUBE_SCOPES,
  };
  const res = await fetchJson<{ items?: Channel[] }>(`${DATA}/channels?${qs({ part: "snippet,statistics,contentDetails", mine: "true" })}`, {
    headers: auth(tokens),
  });
  return (res.items ?? []).map((c) => ({
    network: "youtube" as const,
    externalId: c.id,
    name: c.snippet.title,
    username: c.snippet.customUrl ?? null,
    pictureUrl: c.snippet.thumbnails?.medium?.url ?? c.snippet.thumbnails?.default?.url ?? null,
    tokens,
    meta: { uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null },
  }));
}

async function refreshTokens(ctx: ConnectionContext): Promise<TokenSet | null> {
  if (!ctx.refreshToken) return null;
  const tok = await tokenRequest({ refresh_token: ctx.refreshToken, grant_type: "refresh_token" });
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? ctx.refreshToken,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
  };
}

interface Report {
  columnHeaders: { name: string }[];
  rows?: (string | number)[][];
}

async function report(ctx: ConnectionContext, params: Record<string, string | number | undefined>): Promise<Report> {
  return fetchJson<Report>(`${ANALYTICS}?${qs({ ids: "channel==MINE", ...params })}`, { headers: auth(ctx) });
}

const ACCOUNT_METRICS = "views,estimatedMinutesWatched,averageViewDuration,likes,dislikes,comments,shares,subscribersGained,subscribersLost";
const RENAME: Record<string, string> = {
  estimatedMinutesWatched: "watch_time_minutes",
  averageViewDuration: "avg_view_duration_seconds",
  averageViewPercentage: "avg_view_percentage",
  subscribersGained: "subscribers_gained",
  subscribersLost: "subscribers_lost",
  viewerPercentage: "viewer_percentage",
};

async function syncAccount(ctx: ConnectionContext, range: SyncRange): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  const today = isoDate(new Date());
  const ch = await fetchJson<{ items?: Channel[] }>(`${DATA}/channels?${qs({ part: "statistics", id: ctx.externalId })}`, { headers: auth(ctx) });
  const st = ch.items?.[0]?.statistics;
  if (st) {
    points.push({ metric: "subscribers", date: today, value: Number(st.subscriberCount ?? 0) });
    points.push({ metric: "total_views", date: today, value: Number(st.viewCount ?? 0) });
    points.push({ metric: "video_count", date: today, value: Number(st.videoCount ?? 0) });
  }
  const r = await report(ctx, {
    startDate: isoDate(range.since),
    endDate: isoDate(range.until),
    metrics: ACCOUNT_METRICS,
    dimensions: "day",
    sort: "day",
  });
  const headers = r.columnHeaders.map((h) => h.name);
  for (const row of r.rows ?? []) {
    const day = String(row[0]);
    headers.forEach((h, i) => {
      if (i === 0) return;
      points.push({ metric: RENAME[h] ?? h, date: day, value: Number(row[i]) || 0 });
    });
  }
  return points;
}

interface PlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt?: string };
  snippet: { publishedAt: string };
}
interface Video {
  id: string;
  snippet: { title: string; description?: string; publishedAt: string; thumbnails?: { high?: { url?: string }; medium?: { url?: string } } };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
  contentDetails?: { duration?: string };
}

function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

async function syncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  let uploads = (ctx.meta.uploadsPlaylistId as string | undefined) ?? null;
  if (!uploads) {
    const ch = await fetchJson<{ items?: Channel[] }>(`${DATA}/channels?${qs({ part: "contentDetails", id: ctx.externalId })}`, { headers: auth(ctx) });
    uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  }
  if (!uploads) return [];
  const ids: string[] = [];
  let pageToken: string | undefined;
  let stop = false;
  while (!stop) {
    const page = await fetchJson<{ items?: PlaylistItem[]; nextPageToken?: string }>(
      `${DATA}/playlistItems?${qs({ part: "snippet,contentDetails", playlistId: uploads, maxResults: 50, pageToken })}`,
      { headers: auth(ctx) },
    );
    for (const it of page.items ?? []) {
      const published = new Date(it.contentDetails.videoPublishedAt ?? it.snippet.publishedAt);
      if (published < range.since) {
        stop = true;
        break;
      }
      if (published <= range.until) ids.push(it.contentDetails.videoId);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const out: PostRecord[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetchJson<{ items?: Video[] }>(`${DATA}/videos?${qs({ part: "snippet,statistics,contentDetails", id: batch.join(",") })}`, {
      headers: auth(ctx),
    });
    const analytics = await videoAnalytics(ctx, batch, range);
    for (const v of res.items ?? []) {
      const duration = parseDuration(v.contentDetails?.duration);
      out.push({
        externalId: v.id,
        type: duration > 0 && duration <= 180 ? "short" : "video",
        title: v.snippet.title,
        caption: v.snippet.description ?? null,
        permalink: `https://www.youtube.com/watch?v=${v.id}`,
        thumbnailUrl: v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.medium?.url ?? null,
        publishedAt: new Date(v.snippet.publishedAt),
        raw: v,
        metrics: {
          views: Number(v.statistics?.viewCount ?? 0),
          likes: Number(v.statistics?.likeCount ?? 0),
          comments: Number(v.statistics?.commentCount ?? 0),
          duration_seconds: duration,
          ...(analytics[v.id] ?? {}),
        },
      });
    }
  }
  return out;
}

async function videoAnalytics(ctx: ConnectionContext, ids: string[], range: SyncRange): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  if (ids.length === 0) return out;
  try {
    const r = await report(ctx, {
      startDate: "2015-01-01",
      endDate: isoDate(range.until),
      metrics: "estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained",
      dimensions: "video",
      filters: `video==${ids.join(",")}`,
      maxResults: 200,
    });
    const headers = r.columnHeaders.map((h) => h.name);
    for (const row of r.rows ?? []) {
      const id = String(row[0]);
      out[id] = {};
      headers.forEach((h, i) => {
        if (i === 0) return;
        out[id][RENAME[h] ?? h] = Number(row[i]) || 0;
      });
    }
  } catch (err) {
    if (!(err instanceof ConnectorHttpError)) throw err; // Analytics für Fremd-/gelöschte Videos liefert 400
  }
  return out;
}

async function syncAudience(ctx: ConnectionContext): Promise<AudienceRow[]> {
  const rows: AudienceRow[] = [];
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86_400_000);
  const base = { startDate: isoDate(start), endDate: isoDate(end) };
  const combos: { params: Record<string, string>; dimension: string; keyFn: (row: (string | number)[]) => string; valueIndex: number }[] = [
    {
      params: { metrics: "viewerPercentage", dimensions: "ageGroup,gender" },
      dimension: "age_gender",
      keyFn: (r) => `${String(r[0]).replace(/^age/, "")}|${String(r[1]).startsWith("f") ? "F" : String(r[1]).startsWith("m") ? "M" : "U"}`,
      valueIndex: 2,
    },
    { params: { metrics: "views,estimatedMinutesWatched", dimensions: "country", sort: "-views", maxResults: "50" }, dimension: "country", keyFn: (r) => String(r[0]), valueIndex: 1 },
    { params: { metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views" }, dimension: "traffic_source", keyFn: (r) => String(r[0]), valueIndex: 1 },
    { params: { metrics: "views", dimensions: "deviceType", sort: "-views" }, dimension: "device", keyFn: (r) => String(r[0]), valueIndex: 1 },
    { params: { metrics: "views", dimensions: "subscribedStatus" }, dimension: "subscribed_status", keyFn: (r) => String(r[0]), valueIndex: 1 },
  ];
  for (const c of combos) {
    try {
      const r = await report(ctx, { ...base, ...c.params });
      for (const row of r.rows ?? []) rows.push({ dimension: c.dimension, key: c.keyFn(row), value: Number(row[c.valueIndex]) || 0 });
    } catch (err) {
      if (!(err instanceof ConnectorHttpError)) throw err;
    }
  }
  return rows;
}

const publishOptions = z.object({
  privacyStatus: z.enum(["public", "unlisted", "private"]).default("public"),
  tags: z.array(z.string()).max(50).optional(),
  categoryId: z.string().default("22").describe("YouTube-Kategorie, 22 = People & Blogs, 24 = Entertainment, 27 = Education"),
  madeForKids: z.boolean().default(false),
  publishAt: z.string().datetime().optional().describe("Geplante Veröffentlichung (nur mit privacyStatus=private)"),
  defaultLanguage: z.string().optional().describe("z. B. de"),
  notifySubscribers: z.boolean().default(true),
  playlistId: z.string().optional(),
});

async function publishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = publishOptions.parse(input.options ?? {});
  const metadata = {
    snippet: {
      title: (input.title ?? input.text.split("\n")[0] ?? "Video").slice(0, 100),
      description: input.text.slice(0, 5000),
      tags: o.tags,
      categoryId: o.categoryId,
      defaultLanguage: o.defaultLanguage,
    },
    status: {
      privacyStatus: o.publishAt ? "private" : o.privacyStatus,
      selfDeclaredMadeForKids: o.madeForKids,
      publishAt: o.publishAt,
    },
  };
  const init = await fetchJson<Response>(
    `https://www.googleapis.com/upload/youtube/v3/videos?${qs({ uploadType: "resumable", part: "snippet,status", notifySubscribers: String(o.notifySubscribers) })}`,
    {
      method: "POST",
      headers: {
        ...auth(ctx),
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(input.sizeBytes),
        "x-upload-content-type": input.mimeType,
      },
      body: JSON.stringify(metadata),
      raw: true,
      retries: 1,
    },
  );
  const location = init.headers.get("location");
  if (!location) throw new Error("YouTube hat keine Upload-URL geliefert.");
  const stream = Readable.toWeb(fs.createReadStream(input.filePath)) as unknown as ReadableStream;
  const res = await fetch(location, {
    method: "PUT",
    headers: { "content-length": String(input.sizeBytes), "content-type": input.mimeType },
    body: stream,
    // @ts-expect-error Node-fetch benötigt duplex für Streams
    duplex: "half",
  });
  if (!res.ok) throw new ConnectorHttpError(`YouTube-Upload fehlgeschlagen: ${res.status}`, res.status, await res.text(), location);
  const video = (await res.json()) as { id: string; status?: { uploadStatus?: string } };
  if (o.playlistId) {
    try {
      await fetchJson(`${DATA}/playlistItems?part=snippet`, {
        method: "POST",
        headers: { ...auth(ctx), "content-type": "application/json" },
        body: JSON.stringify({ snippet: { playlistId: o.playlistId, resourceId: { kind: "youtube#video", videoId: video.id } } }),
        retries: 1,
      });
    } catch {
      /* Playlist optional */
    }
  }
  return {
    externalId: video.id,
    permalink: `https://www.youtube.com/watch?v=${video.id}`,
    status: video.status?.uploadStatus === "processed" ? "published" : "processing",
    raw: video,
  };
}

async function checkPublishStatus(ctx: ConnectionContext, result: PublishResult): Promise<PublishResult> {
  const res = await fetchJson<{ items?: { status?: { uploadStatus?: string; failureReason?: string }; processingDetails?: { processingStatus?: string } }[] }>(
    `${DATA}/videos?${qs({ part: "status,processingDetails", id: result.externalId })}`,
    { headers: auth(ctx) },
  );
  const it = res.items?.[0];
  if (it?.status?.uploadStatus === "failed" || it?.status?.uploadStatus === "rejected") {
    throw new Error(`YouTube hat das Video abgelehnt: ${it.status.failureReason ?? it.status.uploadStatus}`);
  }
  const done = it?.status?.uploadStatus === "processed" || it?.processingDetails?.processingStatus === "succeeded";
  return { ...result, status: done ? "published" : "processing" };
}

export const youtubeConnector: Connector = {
  network: "youtube",
  provider: "google",
  label: "YouTube",
  scopes: YOUTUBE_SCOPES,
  configured,
  authorizationUrl,
  exchangeCode,
  refreshTokens,
  syncAccount,
  syncPosts,
  syncAudience,
  publishVideo,
  checkPublishStatus,
  publishOptionsSchema: publishOptions,
  accountMetrics: [
    { key: "subscribers", label: "Abonnenten", aggregation: "last" },
    { key: "total_views", label: "Views gesamt", aggregation: "last" },
    { key: "video_count", label: "Videos", aggregation: "last" },
    { key: "views", label: "Views", aggregation: "sum" },
    { key: "watch_time_minutes", label: "Wiedergabezeit (Min.)", aggregation: "sum" },
    { key: "avg_view_duration_seconds", label: "Ø Wiedergabedauer (s)", aggregation: "avg" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "dislikes", label: "Dislikes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "subscribers_gained", label: "Neue Abonnenten", aggregation: "sum" },
    { key: "subscribers_lost", label: "Verlorene Abonnenten", aggregation: "sum" },
  ],
  postMetrics: [
    { key: "views", label: "Views", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "watch_time_minutes", label: "Wiedergabezeit (Min.)", aggregation: "sum" },
    { key: "avg_view_duration_seconds", label: "Ø Wiedergabedauer (s)", aggregation: "avg" },
    { key: "avg_view_percentage", label: "Ø gesehen (%)", aggregation: "avg" },
    { key: "subscribers_gained", label: "Neue Abonnenten", aggregation: "sum" },
    { key: "duration_seconds", label: "Länge (s)", aggregation: "avg" },
  ],
  audienceDimensions: ["age_gender", "country", "traffic_source", "device", "subscribed_status"],
  notes: [
    "Analytics-Daten laufen 2 bis 3 Tage nach; die letzten Tage sind unvollständig.",
    "Standard-Quota: 10.000 Einheiten/Tag pro Google-Projekt (Upload kostet 1.600).",
    "Geplante Veröffentlichung (publishAt) verlangt privacyStatus=private.",
  ],
};
