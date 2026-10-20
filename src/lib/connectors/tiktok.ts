import fs from "node:fs";
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
 * TikTok: Login Kit (PKCE), Display API (Profil, Videos) und Content Posting API
 * (Direct Post per Chunk-Upload). Access-Tokens leben 24 h, Refresh-Tokens 365 Tage.
 * Ohne App-Audit veröffentlicht TikTok nur privat (SELF_ONLY) und für max. 5 Nutzer/Tag.
 */

export const TIKTOK_SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list", "video.publish", "video.upload"];
const API = "https://open.tiktokapis.com/v2";

function configured() {
  const e = env();
  return !!(e.TIKTOK_CLIENT_KEY && e.TIKTOK_CLIENT_SECRET);
}

function authorizationUrl({ state, redirectUri, codeChallenge }: { state: string; redirectUri: string; codeChallenge?: string }) {
  return `https://www.tiktok.com/v2/auth/authorize/?${qs({
    client_key: env().TIKTOK_CLIENT_KEY,
    scope: TIKTOK_SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallenge ? "S256" : undefined,
  })}`;
}

interface TikTokToken {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  open_id: string;
  scope: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string | undefined>): Promise<TikTokToken> {
  const e = env();
  const res = await fetchJson<TikTokToken>(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ client_key: e.TIKTOK_CLIENT_KEY, client_secret: e.TIKTOK_CLIENT_SECRET, ...params }),
    retries: 1,
  });
  if (res.error) throw new Error(`TikTok OAuth: ${res.error} ${res.error_description ?? ""}`);
  return res;
}

function auth(ctx: { accessToken: string }) {
  return { Authorization: `Bearer ${ctx.accessToken}` };
}

interface UserInfo {
  data?: {
    user?: {
      open_id: string;
      union_id?: string;
      avatar_url?: string;
      display_name?: string;
      username?: string;
      follower_count?: number;
      following_count?: number;
      likes_count?: number;
      video_count?: number;
      profile_deep_link?: string;
    };
  };
  error?: { code?: string; message?: string };
}

async function userInfo(token: string, fields: string): Promise<NonNullable<UserInfo["data"]>["user"]> {
  const res = await fetchJson<UserInfo>(`${API}/user/info/?${qs({ fields })}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.error?.code && res.error.code !== "ok") throw new Error(`TikTok user/info: ${res.error.code} ${res.error.message ?? ""}`);
  return res.data?.user;
}

async function exchangeCode({ code, redirectUri, codeVerifier }: { code: string; redirectUri: string; codeVerifier?: string }): Promise<AccountCandidate[]> {
  const tok = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier });
  const user = await userInfo(tok.access_token, "open_id,union_id,avatar_url,display_name,username,profile_deep_link");
  return [
    {
      network: "tiktok",
      externalId: tok.open_id,
      name: user?.display_name ?? user?.username ?? tok.open_id,
      username: user?.username ?? null,
      pictureUrl: user?.avatar_url ?? null,
      tokens: {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: new Date(Date.now() + tok.expires_in * 1000),
        scopes: tok.scope.split(","),
      },
      meta: {
        refreshExpiresAt: new Date(Date.now() + tok.refresh_expires_in * 1000).toISOString(),
        profileUrl: user?.profile_deep_link ?? null,
      },
    },
  ];
}

async function refreshTokens(ctx: ConnectionContext): Promise<TokenSet | null> {
  if (!ctx.refreshToken) return null;
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: ctx.refreshToken });
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
  };
}

async function syncAccount(ctx: ConnectionContext): Promise<MetricPoint[]> {
  const u = await userInfo(ctx.accessToken, "open_id,follower_count,following_count,likes_count,video_count");
  const today = isoDate(new Date());
  return [
    { metric: "followers", date: today, value: u?.follower_count ?? 0 },
    { metric: "following", date: today, value: u?.following_count ?? 0 },
    { metric: "likes_total", date: today, value: u?.likes_count ?? 0 },
    { metric: "video_count", date: today, value: u?.video_count ?? 0 },
  ];
}

interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  create_time: number;
  cover_image_url?: string;
  share_url?: string;
  embed_link?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

async function syncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  const out: PostRecord[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await fetchJson<{ data?: { videos?: TikTokVideo[]; cursor?: number; has_more?: boolean }; error?: { code?: string; message?: string } }>(
      `${API}/video/list/?${qs({ fields: "id,title,video_description,create_time,cover_image_url,share_url,embed_link,duration,view_count,like_count,comment_count,share_count" })}`,
      { method: "POST", headers: { ...auth(ctx), "content-type": "application/json" }, body: JSON.stringify({ cursor, max_count: 20 }) },
    );
    if (res.error?.code && res.error.code !== "ok") throw new Error(`TikTok video/list: ${res.error.code} ${res.error.message ?? ""}`);
    let stop = false;
    for (const v of res.data?.videos ?? []) {
      const published = new Date(v.create_time * 1000);
      if (published < range.since) {
        stop = true;
        break;
      }
      if (published > range.until) continue;
      out.push({
        externalId: v.id,
        type: "video",
        title: v.title ?? null,
        caption: v.video_description ?? v.title ?? null,
        permalink: v.share_url ?? null,
        thumbnailUrl: v.cover_image_url ?? null,
        publishedAt: published,
        raw: v,
        metrics: {
          views: v.view_count ?? 0,
          likes: v.like_count ?? 0,
          comments: v.comment_count ?? 0,
          shares: v.share_count ?? 0,
          duration_seconds: v.duration ?? 0,
        },
      });
    }
    if (stop || !res.data?.has_more) break;
    cursor = res.data.cursor;
  }
  return out;
}

async function syncAudience(): Promise<AudienceRow[]> {
  return []; // Display API liefert keine Demografie (nur TikTok Business API).
}

const publishOptions = z.object({
  privacyLevel: z
    .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
    .default("PUBLIC_TO_EVERYONE")
    .describe("Nicht auditierte Apps dürfen nur SELF_ONLY"),
  disableComment: z.boolean().default(false),
  disableDuet: z.boolean().default(false),
  disableStitch: z.boolean().default(false),
  videoCoverTimestampMs: z.number().int().min(0).default(1000),
  brandContentToggle: z.boolean().default(false).describe("Bezahlte Partnerschaft"),
  brandOrganicToggle: z.boolean().default(false).describe("Eigene Marke bewerben"),
  isAigc: z.boolean().default(false).describe("KI-generierter Inhalt"),
});

interface CreatorInfo {
  data?: { privacy_level_options?: string[]; max_video_post_duration_sec?: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean };
  error?: { code?: string; message?: string };
}

async function publishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = publishOptions.parse(input.options ?? {});
  const info = await fetchJson<CreatorInfo>(`${API}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json; charset=UTF-8" },
    body: "{}",
    retries: 1,
  });
  if (info.error?.code && info.error.code !== "ok") throw new Error(`TikTok creator_info: ${info.error.code} ${info.error.message ?? ""}`);
  const allowed = info.data?.privacy_level_options ?? [];
  let privacy = o.privacyLevel;
  if (allowed.length && !allowed.includes(privacy)) {
    if (!allowed.includes("SELF_ONLY") && allowed[0]) privacy = allowed[0] as typeof privacy;
    else privacy = "SELF_ONLY";
  }

  const size = input.sizeBytes;
  const MAX_SINGLE = 64 * 1024 * 1024;
  const chunkSize = size <= MAX_SINGLE ? size : 50 * 1024 * 1024;
  const totalChunks = size <= MAX_SINGLE ? 1 : Math.max(1, Math.floor(size / chunkSize));

  const init = await fetchJson<{ data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string } }>(
    `${API}/post/publish/video/init/`,
    {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        post_info: {
          title: input.text.slice(0, 2200),
          privacy_level: privacy,
          disable_duet: o.disableDuet,
          disable_comment: o.disableComment,
          disable_stitch: o.disableStitch,
          video_cover_timestamp_ms: o.videoCoverTimestampMs,
          brand_content_toggle: o.brandContentToggle,
          brand_organic_toggle: o.brandOrganicToggle,
          is_aigc: o.isAigc,
        },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunks },
      }),
      retries: 1,
    },
  );
  if (init.error?.code && init.error.code !== "ok") throw new Error(`TikTok video/init: ${init.error.code} ${init.error.message ?? ""}`);
  const publishId = init.data?.publish_id;
  const uploadUrl = init.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error("TikTok hat keine Upload-URL geliefert.");

  const fd = fs.openSync(input.filePath, "r");
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = i === totalChunks - 1 ? size - 1 : start + chunkSize - 1;
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": input.mimeType || "video/mp4",
          "content-length": String(len),
          "content-range": `bytes ${start}-${end}/${size}`,
        },
        body: new Uint8Array(buf),
      });
      if (!res.ok && res.status !== 206) {
        throw new ConnectorHttpError(`TikTok-Chunk-Upload fehlgeschlagen: ${res.status}`, res.status, await res.text(), uploadUrl);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return checkPublishStatus(ctx, { externalId: publishId, status: "processing", raw: { publishId } });
}

async function checkPublishStatus(ctx: ConnectionContext, result: PublishResult): Promise<PublishResult> {
  const publishId = (result.raw as { publishId?: string } | undefined)?.publishId ?? result.externalId;
  const res = await fetchJson<{
    data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[]; publicly_available_post_id?: (string | number)[] };
    error?: { code?: string; message?: string };
  }>(`${API}/post/publish/status/fetch/`, {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (res.error?.code && res.error.code !== "ok") throw new Error(`TikTok status/fetch: ${res.error.code} ${res.error.message ?? ""}`);
  const status = res.data?.status;
  if (status === "FAILED") throw new Error(`TikTok-Veröffentlichung fehlgeschlagen: ${res.data?.fail_reason ?? "unbekannt"}`);
  const ids = res.data?.publicaly_available_post_id ?? res.data?.publicly_available_post_id ?? [];
  if (status === "PUBLISH_COMPLETE") {
    const postId = ids[0] ? String(ids[0]) : publishId;
    const username = (ctx.meta.username as string | undefined) ?? ctx.name;
    return { externalId: postId, permalink: ids[0] ? `https://www.tiktok.com/@${username}/video/${postId}` : null, status: "published", raw: { publishId, ...res.data } };
  }
  return { ...result, raw: { publishId, ...res.data }, status: "processing" };
}

export const tiktokConnector: Connector = {
  network: "tiktok",
  provider: "tiktok",
  label: "TikTok",
  scopes: TIKTOK_SCOPES,
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
    { key: "followers", label: "Follower", aggregation: "last" },
    { key: "following", label: "Folgt", aggregation: "last" },
    { key: "likes_total", label: "Likes gesamt", aggregation: "last" },
    { key: "video_count", label: "Videos", aggregation: "last" },
  ],
  postMetrics: [
    { key: "views", label: "Views", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "duration_seconds", label: "Länge (s)", aggregation: "avg" },
  ],
  audienceDimensions: [],
  notes: [
    "Die TikTok Display API liefert nur Profil-Zähler und Video-Statistiken, keine Tages-Zeitreihen und keine Demografie (dafür braucht es die TikTok Business API).",
    "Vor dem App-Audit sind Veröffentlichungen nur privat (SELF_ONLY) möglich, max. 5 Nutzer pro Tag.",
    "Access-Token läuft nach 24 h ab und wird automatisch über das Refresh-Token erneuert.",
  ],
};
