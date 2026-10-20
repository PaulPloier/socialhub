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
 * LinkedIn Unternehmensseiten über die Community Management API (versionierte
 * /rest-Endpunkte). Erfordert Zugang zum "Community Management API"-Produkt.
 * Tokens laufen nach 60 Tagen ab; programmatischer Refresh nur mit Freischaltung.
 */

export const LINKEDIN_SCOPES = ["openid", "profile", "r_organization_social", "w_organization_social", "rw_organization_admin", "r_organization_admin"];
const REST = "https://api.linkedin.com/rest";

function configured() {
  const e = env();
  return !!(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_SECRET);
}

function authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
  return `https://www.linkedin.com/oauth/v2/authorization?${qs({
    response_type: "code",
    client_id: env().LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  })}`;
}

interface LiToken {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string | undefined>): Promise<LiToken> {
  const e = env();
  return fetchJson<LiToken>("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: e.LINKEDIN_CLIENT_ID, client_secret: e.LINKEDIN_CLIENT_SECRET, ...params }),
    retries: 1,
  });
}

function headers(ctx: { accessToken: string }, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${ctx.accessToken}`,
    "LinkedIn-Version": env().LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

const orgUrn = (id: string) => `urn:li:organization:${id}`;
const enc = encodeURIComponent;

interface OrgAcl {
  organization: string;
  role: string;
  state: string;
}
interface Organization {
  id: number;
  localizedName?: string;
  vanityName?: string;
  logoV2?: { "original~"?: { elements?: { identifiers?: { identifier?: string }[] }[] } };
}

async function exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<AccountCandidate[]> {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const tokens: TokenSet = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    scopes: tok.scope?.split(/[ ,]/) ?? LINKEDIN_SCOPES,
  };
  const acls = await fetchJson<{ elements?: OrgAcl[] }>(`${REST}/organizationAcls?${qs({ q: "roleAssignee", role: "ADMINISTRATOR", state: "APPROVED", count: 50 })}`, {
    headers: headers(tokens),
  });
  const out: AccountCandidate[] = [];
  for (const acl of acls.elements ?? []) {
    const id = acl.organization.split(":").pop()!;
    let org: Organization | null = null;
    try {
      org = await fetchJson<Organization>(`${REST}/organizations/${id}?projection=(id,localizedName,vanityName,logoV2(original~:playableStreams))`, {
        headers: headers(tokens),
      });
    } catch {
      /* Name optional */
    }
    out.push({
      network: "linkedin",
      externalId: id,
      name: org?.localizedName ?? `LinkedIn-Seite ${id}`,
      username: org?.vanityName ?? null,
      pictureUrl: org?.logoV2?.["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier ?? null,
      tokens,
      meta: { refreshExpiresAt: tok.refresh_token_expires_in ? new Date(Date.now() + tok.refresh_token_expires_in * 1000).toISOString() : null },
    });
  }
  return out;
}

async function refreshTokens(ctx: ConnectionContext): Promise<TokenSet | null> {
  if (!ctx.refreshToken) return null;
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: ctx.refreshToken });
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? ctx.refreshToken,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
  };
}

function timeIntervals(range: SyncRange) {
  return `(timeRange:(start:${range.since.getTime()},end:${range.until.getTime()}),timeGranularityType:DAY)`;
}

interface ShareStats {
  impressionCount?: number;
  uniqueImpressionsCount?: number;
  clickCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  engagement?: number;
}

function mapShareStats(s: ShareStats | undefined): Record<string, number> {
  if (!s) return {};
  return {
    impressions: s.impressionCount ?? 0,
    unique_impressions: s.uniqueImpressionsCount ?? 0,
    clicks: s.clickCount ?? 0,
    likes: s.likeCount ?? 0,
    comments: s.commentCount ?? 0,
    shares: s.shareCount ?? 0,
    engagement_rate: (s.engagement ?? 0) * 100,
  };
}

async function syncAccount(ctx: ConnectionContext, range: SyncRange): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  const today = isoDate(new Date());
  const urn = orgUrn(ctx.externalId);
  try {
    const size = await fetchJson<{ firstDegreeSize?: number }>(`${REST}/networkSizes/${enc(urn)}?edgeType=CompanyFollowedByMember`, { headers: headers(ctx) });
    points.push({ metric: "followers", date: today, value: size.firstDegreeSize ?? 0 });
  } catch (err) {
    if (!(err instanceof ConnectorHttpError)) throw err;
  }
  const ti = timeIntervals(range);
  const follower = await fetchJson<{ elements?: { timeRange: { start: number }; followerGains?: { organicFollowerGain?: number; paidFollowerGain?: number } }[] }>(
    `${REST}/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc(urn)}&timeIntervals=${ti}`,
    { headers: headers(ctx) },
  );
  for (const el of follower.elements ?? []) {
    const date = isoDate(new Date(el.timeRange.start));
    points.push({ metric: "followers_gained", date, value: (el.followerGains?.organicFollowerGain ?? 0) + (el.followerGains?.paidFollowerGain ?? 0) });
  }
  const shares = await fetchJson<{ elements?: { timeRange: { start: number }; totalShareStatistics?: ShareStats }[] }>(
    `${REST}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(urn)}&timeIntervals=${ti}`,
    { headers: headers(ctx) },
  );
  for (const el of shares.elements ?? []) {
    const date = isoDate(new Date(el.timeRange.start));
    for (const [k, v] of Object.entries(mapShareStats(el.totalShareStatistics))) points.push({ metric: k, date, value: v });
  }
  try {
    const views = await fetchJson<{ elements?: { timeRange: { start: number }; totalPageStatistics?: { views?: { allPageViews?: { pageViews?: number } } } }[] }>(
      `${REST}/organizationPageStatistics?q=organization&organization=${enc(urn)}&timeIntervals=${ti}`,
      { headers: headers(ctx) },
    );
    for (const el of views.elements ?? []) {
      points.push({ metric: "page_views", date: isoDate(new Date(el.timeRange.start)), value: el.totalPageStatistics?.views?.allPageViews?.pageViews ?? 0 });
    }
  } catch (err) {
    if (!(err instanceof ConnectorHttpError)) throw err;
  }
  return points;
}

interface LiPost {
  id: string;
  commentary?: string;
  createdAt?: number;
  publishedAt?: number;
  lifecycleState?: string;
  content?: { media?: { id?: string; title?: string }; article?: { title?: string; source?: string }; multiImage?: unknown };
}

async function syncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]> {
  const urn = orgUrn(ctx.externalId);
  const all: LiPost[] = [];
  let start = 0;
  for (let i = 0; i < 20; i++) {
    const res = await fetchJson<{ elements?: LiPost[]; paging?: { total?: number } }>(
      `${REST}/posts?${qs({ author: urn, q: "author", count: 50, start, sortBy: "LAST_MODIFIED" })}`,
      { headers: headers(ctx) },
    );
    const els = res.elements ?? [];
    all.push(...els);
    if (els.length < 50) break;
    start += 50;
  }
  const inRange = all.filter((p) => {
    const t = p.publishedAt ?? p.createdAt ?? 0;
    return t >= range.since.getTime() && t <= range.until.getTime();
  });
  const statsByUrn = new Map<string, Record<string, number>>();
  const shares = inRange.filter((p) => p.id.includes(":share:")).map((p) => p.id);
  const ugc = inRange.filter((p) => p.id.includes(":ugcPost:")).map((p) => p.id);
  for (const [param, list] of [
    ["shares", shares],
    ["ugcPosts", ugc],
  ] as const) {
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      try {
        const res = await fetchJson<{ elements?: { share?: string; ugcPost?: string; totalShareStatistics?: ShareStats }[] }>(
          `${REST}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(urn)}&${param}=List(${batch.map(enc).join(",")})`,
          { headers: headers(ctx) },
        );
        for (const el of res.elements ?? []) {
          const key = el.share ?? el.ugcPost;
          if (key) statsByUrn.set(key, mapShareStats(el.totalShareStatistics));
        }
      } catch (err) {
        if (!(err instanceof ConnectorHttpError)) throw err;
      }
    }
  }
  return inRange.map((p) => ({
    externalId: p.id,
    type: p.content?.media ? "media" : p.content?.article ? "article" : p.content?.multiImage ? "multi_image" : "text",
    title: p.content?.media?.title ?? p.content?.article?.title ?? null,
    caption: p.commentary ?? null,
    permalink: `https://www.linkedin.com/feed/update/${p.id}`,
    publishedAt: new Date(p.publishedAt ?? p.createdAt ?? Date.now()),
    raw: p,
    metrics: statsByUrn.get(p.id) ?? {},
  }));
}

async function syncAudience(ctx: ConnectionContext): Promise<AudienceRow[]> {
  const urn = orgUrn(ctx.externalId);
  const rows: AudienceRow[] = [];
  const res = await fetchJson<{ elements?: Record<string, unknown>[] }>(
    `${REST}/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc(urn)}`,
    { headers: headers(ctx) },
  );
  const el = res.elements?.[0];
  if (!el) return rows;
  const groups: { field: string; dimension: string; keyField: string }[] = [
    { field: "followerCountsByGeoCountry", dimension: "country", keyField: "geo" },
    { field: "followerCountsByGeo", dimension: "region", keyField: "geo" },
    { field: "followerCountsByIndustry", dimension: "industry", keyField: "industry" },
    { field: "followerCountsBySeniority", dimension: "seniority", keyField: "seniority" },
    { field: "followerCountsByFunction", dimension: "function", keyField: "function" },
    { field: "followerCountsByStaffCountRange", dimension: "company_size", keyField: "staffCountRange" },
  ];
  for (const g of groups) {
    const list = el[g.field] as { [k: string]: unknown; followerCounts?: { organicFollowerCount?: number; paidFollowerCount?: number } }[] | undefined;
    for (const item of list ?? []) {
      const key = String(item[g.keyField] ?? "unknown");
      const v = (item.followerCounts?.organicFollowerCount ?? 0) + (item.followerCounts?.paidFollowerCount ?? 0);
      rows.push({ dimension: g.dimension, key, value: v });
    }
  }
  return rows;
}

/** LinkedIn "little text format": Sonderzeichen im Commentary müssen escaped werden. */
export function escapeLinkedInText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

const publishOptions = z.object({
  visibility: z.enum(["PUBLIC", "LOGGED_IN"]).default("PUBLIC"),
  mediaTitle: z.string().max(200).optional(),
});

async function publishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult> {
  const o = publishOptions.parse(input.options ?? {});
  const owner = orgUrn(ctx.externalId);
  const init = await fetchJson<{ value: { video: string; uploadToken?: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(
    `${REST}/videos?action=initializeUpload`,
    {
      method: "POST",
      headers: headers(ctx, { "content-type": "application/json" }),
      body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: input.sizeBytes, uploadCaptions: false, uploadThumbnail: false } }),
      retries: 1,
    },
  );
  const fd = fs.openSync(input.filePath, "r");
  const etags: string[] = [];
  try {
    for (const part of init.value.uploadInstructions) {
      const len = part.lastByte - part.firstByte + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, part.firstByte);
      const res = await fetch(part.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(buf) });
      if (!res.ok) throw new ConnectorHttpError(`LinkedIn-Chunk-Upload fehlgeschlagen: ${res.status}`, res.status, await res.text(), part.uploadUrl);
      etags.push(res.headers.get("etag") ?? "");
    }
  } finally {
    fs.closeSync(fd);
  }
  await fetchJson(`${REST}/videos?action=finalizeUpload`, {
    method: "POST",
    headers: headers(ctx, { "content-type": "application/json" }),
    body: JSON.stringify({ finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken ?? "", uploadedPartIds: etags } }),
    retries: 1,
  });
  // Auf Verarbeitung warten (max. ~2 Minuten), dann Post anlegen.
  for (let i = 0; i < 24; i++) {
    const v = await fetchJson<{ status?: string }>(`${REST}/videos/${enc(init.value.video)}`, { headers: headers(ctx) });
    if (v.status === "AVAILABLE") break;
    if (v.status === "PROCESSING_FAILED") throw new Error("LinkedIn konnte das Video nicht verarbeiten.");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const res = await fetchJson<Response>(`${REST}/posts`, {
    method: "POST",
    headers: headers(ctx, { "content-type": "application/json" }),
    body: JSON.stringify({
      author: owner,
      commentary: escapeLinkedInText(input.text).slice(0, 3000),
      visibility: o.visibility,
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: init.value.video, title: o.mediaTitle ?? input.title ?? undefined } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    raw: true,
    retries: 1,
  });
  const postUrn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? init.value.video;
  return { externalId: postUrn, permalink: `https://www.linkedin.com/feed/update/${postUrn}`, status: "published", raw: { video: init.value.video } };
}

export const linkedinConnector: Connector = {
  network: "linkedin",
  provider: "linkedin",
  label: "LinkedIn-Seite",
  scopes: LINKEDIN_SCOPES,
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
    { key: "followers_gained", label: "Neue Follower", aggregation: "sum" },
    { key: "impressions", label: "Impressionen", aggregation: "sum" },
    { key: "unique_impressions", label: "Eindeutige Impressionen", aggregation: "sum" },
    { key: "clicks", label: "Klicks", aggregation: "sum" },
    { key: "likes", label: "Reaktionen", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "engagement_rate", label: "Engagement-Rate (%)", aggregation: "avg" },
    { key: "page_views", label: "Seitenaufrufe", aggregation: "sum" },
  ],
  postMetrics: [
    { key: "impressions", label: "Impressionen", aggregation: "sum" },
    { key: "unique_impressions", label: "Eindeutige Impressionen", aggregation: "sum" },
    { key: "clicks", label: "Klicks", aggregation: "sum" },
    { key: "likes", label: "Reaktionen", aggregation: "sum" },
    { key: "comments", label: "Kommentare", aggregation: "sum" },
    { key: "shares", label: "Geteilt", aggregation: "sum" },
    { key: "engagement_rate", label: "Engagement-Rate (%)", aggregation: "avg" },
  ],
  audienceDimensions: ["country", "region", "industry", "seniority", "function", "company_size"],
  notes: [
    "Nur Unternehmensseiten (keine Personenprofile). Der verbindende Nutzer muss Seiten-Admin sein.",
    "Zugang zur Community Management API muss im LinkedIn-Developer-Portal beantragt werden.",
    "Demografie-Schlüssel kommen als LinkedIn-URNs (urn:li:geo:…); die Auflösung in Namen ist ein Folgeschritt.",
    "Token laufen nach 60 Tagen ab; Refresh nur mit Freischaltung, sonst neu verbinden.",
  ],
};
