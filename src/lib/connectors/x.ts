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
 * X (Twitter) API v2 mit OAuth 2.0 PKCE. Access-Tokens leben 2 h, Refresh über
 * offline.access. Video-Upload über die v2-Media-Endpunkte (chunked).
 * Hinweis: Die X-API ist kostenpflichtig (Basic-Tier oder höher für Posting + Metriken).
 */

export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
const API = "https://api.x.com/2";

function configured() {
  const e = env();
  return !!(e.X_CLIENT_ID && e.X_CLIENT_SECRET);
}

function authorizationUrl({ state, redirectUri, codeChallenge }: { state: string; redirectUri: string; codeChallenge?: string }) {
  return `https://x.com/i/oauth2/authorize?${qs({
    response_type: "code",
    client_id: env().X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: X_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge ?? "challenge",
    code_challenge_method: codeChallenge ? "S256" : "plain",
  })}`;
}

interface XToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string | undefined>): Promise<XToken> {
  const e = env();
  const basic = Buffer.from(`${e.X_CLIENT_ID}:${e.X_CLIENT_SECRET}`).toString("base64");
  return fetchJson<XToken>(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: formBody({ client_id: e.X_CLIENT_ID, ...params }),
    retries: 1,
  });
}

function auth(ctx: { accessToken: string }) {
  return { Authorization: `Bearer ${ctx.accessToken}` };
}

interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number; like_count?: number };
}

async function me(token: string): Promise<XUser> {
  const res = await fetchJson<{ data: XUser }>(`${API}/users/me?${qs({ "user.fields": "public_metrics,profile_image_url,username,name" })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

async function exchangeCode({ code, redirectUri, codeVerifier }: { code: string; redirectUri: string; codeVerifier?: string }): Promise<AccountCandidate[]> {
  const tok = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier ?? "challenge" });
  const user = await me(tok.access_token);
  return [
    {
      network: "x",
      externalId: user.id,
      name: user.name,
      username: user.username,
      pictureUrl: user.profile_image_url?.replace("_normal", "_400x400") ?? null,
      tokens: {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        expiresAt: new Date(Date.now() + tok.expires_in * 1000),
        scopes: tok.scope?.split(" ") ?? X_SCOPES,
      },
      meta: { username: user.username },
    },
  ];
}

async function refreshTokens(ctx: ConnectionContext): Promise<TokenSet | null> {
  if (!ctx.refreshToken) return null;
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: ctx.refreshToken });
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? ctx.refreshToken, expiresAt: new Date(Date.now() + tok.expires_in * 1000) };
}

async function syncAccount(ctx: ConnectionContext): Promise<MetricPoint[]> {
  const user = await me(ctx.accessToken);
  const today = isoDate(new Date());
  const m = user.public_metrics ?? {};
  return [
    { metric: "followers", date: today, value: m.followers_count ?? 0 },
    { metric: "following", date: today, value: m.following_count ?? 0 },
    { metric: "tweet_count", date: today, value: m.tweet_count ?? 0 },
    { metric: "listed_count", date: today, value: m.listed_count ?? 0 },
  ];
}

interface Tweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: { retweet_count?: number; reply_count?: number; like_count?: number; quote_count?: number; bookmark_count?: number; impression_count?: number };
  non_public_metrics?: { impression_count?: number; url_link_clicks?: number; user_profile_clicks?: number };
  organic_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; url_link_clicks?: number; user_profile_clicks?: number };
  attachments?: { media_keys?: string[] };
}

async function syncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  const out: PostRecord[] = [];
  const username = (ctx.meta.username as string | undefined) ?? ctx.name;
  let pagination: string | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await fetchJson<{ data?: Tweet[]; meta?: { next_token?: string } }>(
      `${API}/users/${ctx.externalId}/tweets?${qs({
        max_results: 100,
        "tweet.fields": "created_at,public_metrics,attachments,text",
        exclude: "retweets,replies",
        start_time: range.since.toISOString(),
        end_time: new Date(Math.min(range.until.getTime(), Date.now() - 15_000)).toISOString(),
        pagination_token: pagination,
      })}`,
      { headers: auth(ctx) },
    );
    for (const t of res.data ?? []) {
      const m = t.public_metrics ?? {};
      out.push({
        externalId: t.id,
        type: t.attachments?.media_keys?.length ? "media" : "text",
        caption: t.text,
        permalink: `https://x.com/${username}/status/${t.id}`,
        publishedAt: new Date(t.created_at),
        raw: t,
        metrics: {
          impressions: m.impression_count ?? 0,
          likes: m.like_count ?? 0,
          retweets: m.retweet_count ?? 0,
          replies: m.reply_count ?? 0,
          quotes: m.quote_count ?? 0,
          bookmarks: m.bookmark_count ?? 0,
        },
      });
    }
    pagination = res.meta?.next_token;
    if (!pagination) break;
  }
  // Nicht-öffentliche Metriken (Link-Klicks, Profil-Klicks) gibt es nur für Posts der letzten 30 Tage.
  const cutoff = Date.now() - 29 * 86_400_000;
  const recent = out.filter((p) => p.publishedAt.getTime() > cutoff);
  for (let i = 0; i < recent.length; i += 100) {
    const batch = recent.slice(i, i + 100);
    try {
      const res = await fetchJson<{ data?: Tweet[] }>(
        `${API}/tweets?${qs({ ids: batch.map((p) => p.externalId).join(","), "tweet.fields": "non_public_metrics,organic_metrics" })}`,
        { headers: auth(ctx) },
      );
      for (const t of res.data ?? []) {
        const p = batch.find((x) => x.externalId === t.id);
        if (!p) continue;
        if (t.non_public_metrics) {
          p.metrics.url_link_clicks = t.non_public_metrics.url_link_clicks ?? 0;
          p.metrics.profile_clicks = t.non_public_metrics.user_profile_clicks ?? 0;
          if (t.non_public_metrics.impression_count) p.metrics.impressions = t.non_public_metrics.impression_count;
        }
      }
    } catch (err) {
      if (!(err instanceof ConnectorHttpError)) throw err;
    }
  }
  return out;
}

async function syncAudience(): Promise<AudienceRow[]> {
  return []; // X v2 liefert keine Follower-Demografie.
}

const publishOptions = z.object({
  replySettings: z.enum(["everyone", "mentionedUsers", "following"]).default("everyone"),
});

async function publishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = publishOptions.parse(input.options ?? {});
  const init = await fetchJson<{ data?: { id?: string } }>(`${API}/media/upload/initialize`, {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({ media_type: input.mimeType || "video/mp4", total_bytes: input.sizeBytes, media_category: "tweet_video" }),
    retries: 1,
  });
  const mediaId = init.data?.id;
  if (!mediaId) throw new Error("X hat keine Media-ID geliefert.");
  const CHUNK = 4 * 1024 * 1024;
  const fd = fs.openSync(input.filePath, "r");
  try {
    let segment = 0;
    for (let start = 0; start < input.sizeBytes; start += CHUNK) {
      const len = Math.min(CHUNK, input.sizeBytes - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const form = new FormData();
      form.set("segment_index", String(segment));
      form.set("media", new Blob([new Uint8Array(buf)], { type: input.mimeType || "video/mp4" }), "chunk");
      const res = await fetch(`${API}/media/upload/${mediaId}/append`, { method: "POST", headers: auth(ctx), body: form });
      if (!res.ok) throw new ConnectorHttpError(`X-Chunk-Upload fehlgeschlagen: ${res.status}`, res.status, await res.text(), `${API}/media/upload/${mediaId}/append`);
      segment++;
    }
  } finally {
    fs.closeSync(fd);
  }
  const fin = await fetchJson<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(`${API}/media/upload/${mediaId}/finalize`, {
    method: "POST",
    headers: auth(ctx),
    retries: 1,
  });
  let state = fin.data?.processing_info?.state;
  for (let i = 0; i < 30 && state && state !== "succeeded"; i++) {
    if (state === "failed") throw new Error("X konnte das Video nicht verarbeiten.");
    await new Promise((r) => setTimeout(r, Math.max(2, fin.data?.processing_info?.check_after_secs ?? 3) * 1000));
    const st = await fetchJson<{ data?: { processing_info?: { state?: string } } }>(`${API}/media/upload?${qs({ command: "STATUS", media_id: mediaId })}`, {
      headers: auth(ctx),
    });
    state = st.data?.processing_info?.state ?? "succeeded";
  }
  const tweet = await fetchJson<{ data: { id: string } }>(`${API}/tweets`, {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({ text: input.text.slice(0, 280), media: { media_ids: [mediaId] }, reply_settings: o.replySettings === "everyone" ? undefined : o.replySettings }),
    retries: 1,
  });
  const username = (ctx.meta.username as string | undefined) ?? ctx.name;
  return { externalId: tweet.data.id, permalink: `https://x.com/${username}/status/${tweet.data.id}`, status: "published", raw: { mediaId } };
}

export const xConnector: Connector = {
  network: "x",
  provider: "x",
  label: "X (Twitter)",
  scopes: X_SCOPES,
  configured,
  authorizationUrl,
  exchangeCode,
  refreshTokens,
  syncAccount,
  syncPosts,
  syncAudience,
  publishVideo,
  publishOptionsSchema: publishOptions,
  accountMetrics: [
    { key: "followers", label: "Follower", aggregation: "last" },
    { key: "following", label: "Folgt", aggregation: "last" },
    { key: "tweet_count", label: "Posts gesamt", aggregation: "last" },
    { key: "listed_count", label: "In Listen", aggregation: "last" },
  ],
  postMetrics: [
    { key: "impressions", label: "Impressionen", aggregation: "sum" },
    { key: "likes", label: "Likes", aggregation: "sum" },
    { key: "retweets", label: "Reposts", aggregation: "sum" },
    { key: "replies", label: "Antworten", aggregation: "sum" },
    { key: "quotes", label: "Zitate", aggregation: "sum" },
    { key: "bookmarks", label: "Lesezeichen", aggregation: "sum" },
    { key: "url_link_clicks", label: "Link-Klicks", aggregation: "sum" },
    { key: "profile_clicks", label: "Profil-Klicks", aggregation: "sum" },
  ],
  audienceDimensions: [],
  notes: [
    "Die X-API ist kostenpflichtig; für Posting und Metriken ist mindestens das Basic-Tier nötig.",
    "Keine Follower-Demografie und keine Tages-Zeitreihen über die API; Account-Zähler werden täglich als Snapshot gespeichert.",
    "Texte werden auf 280 Zeichen gekürzt.",
  ],
};
