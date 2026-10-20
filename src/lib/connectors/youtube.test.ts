import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeConnector } from "./youtube";
import type { ConnectionContext } from "./types";

afterEach(() => vi.unstubAllGlobals());

const ctx: ConnectionContext = { id: "c", brandId: "b", network: "youtube", externalId: "UC123", name: "Kanal", accessToken: "T", refreshToken: "R", scopes: [], meta: { uploadsPlaylistId: "UU123" } };

function stub(handler: (url: URL, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const r = handler(new URL(String(input)), init);
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

describe("YouTube connector", () => {
  it("erneuert abgelaufene Tokens", async () => {
    stub((url, init) => {
      expect(url.hostname).toBe("oauth2.googleapis.com");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return { access_token: "NEW", expires_in: 3600 };
    });
    const t = await youtubeConnector.refreshTokens(ctx);
    expect(t?.accessToken).toBe("NEW");
    expect(t?.refreshToken).toBe("R");
  });

  it("mappt Analytics-Reports auf Tagesmetriken und liest Kanal-Snapshots", async () => {
    stub((url) => {
      if (url.hostname === "youtubeanalytics.googleapis.com") {
        return {
          columnHeaders: [{ name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "subscribersGained" }],
          rows: [
            ["2026-10-01", 100, 40, 2],
            ["2026-10-02", 120, 50, 3],
          ],
        };
      }
      return { items: [{ id: "UC123", snippet: { title: "Kanal" }, statistics: { subscriberCount: "1500", viewCount: "99999", videoCount: "12" } }] };
    });
    const points = await youtubeConnector.syncAccount(ctx, { since: new Date("2026-10-01"), until: new Date("2026-10-02") });
    expect(points.find((p) => p.metric === "subscribers")?.value).toBe(1500);
    expect(points.find((p) => p.metric === "views" && p.date === "2026-10-02")?.value).toBe(120);
    expect(points.find((p) => p.metric === "watch_time_minutes" && p.date === "2026-10-01")?.value).toBe(40);
    expect(points.find((p) => p.metric === "subscribers_gained" && p.date === "2026-10-02")?.value).toBe(3);
  });

  it("liest Videos über die Uploads-Playlist und erkennt Shorts", async () => {
    stub((url) => {
      if (url.pathname.endsWith("/playlistItems")) {
        return { items: [{ contentDetails: { videoId: "v1", videoPublishedAt: "2026-10-01T10:00:00Z" }, snippet: { publishedAt: "2026-10-01T10:00:00Z" } }, { contentDetails: { videoId: "old", videoPublishedAt: "2020-01-01T00:00:00Z" }, snippet: { publishedAt: "2020-01-01T00:00:00Z" } }] };
      }
      if (url.pathname.endsWith("/videos")) {
        return { items: [{ id: "v1", snippet: { title: "Short", publishedAt: "2026-10-01T10:00:00Z" }, statistics: { viewCount: "1000", likeCount: "50", commentCount: "3" }, contentDetails: { duration: "PT45S" } }] };
      }
      if (url.hostname === "youtubeanalytics.googleapis.com") {
        return { columnHeaders: [{ name: "video" }, { name: "estimatedMinutesWatched" }, { name: "averageViewPercentage" }], rows: [["v1", 30, 85.5]] };
      }
      return {};
    });
    const posts = await youtubeConnector.syncPosts(ctx, { since: new Date("2026-09-01"), until: new Date("2026-10-05") });
    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe("short");
    expect(posts[0].metrics).toMatchObject({ views: 1000, likes: 50, comments: 3, duration_seconds: 45, watch_time_minutes: 30, avg_view_percentage: 85.5 });
  });
});
