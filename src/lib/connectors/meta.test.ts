import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookConnector, instagramConnector } from "./meta";
import type { ConnectionContext } from "./types";

type Handler = (url: URL, init?: RequestInit) => unknown;

function mockFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      for (const [pattern, handler] of Object.entries(routes)) {
        if (url.pathname.endsWith(pattern) || url.pathname.includes(pattern)) {
          const result = handler(url, init);
          if (result instanceof Response) return result;
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ error: { message: `no mock for ${url.pathname}` } }), { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ctx: ConnectionContext = {
  id: "c1",
  brandId: "b1",
  network: "instagram",
  externalId: "17841400000000000",
  name: "Test",
  accessToken: "PAGE_TOKEN",
  scopes: [],
  meta: {},
};

describe("Meta connector", () => {
  it("tauscht den Code und liefert Facebook-Seite plus verknüpftes Instagram-Konto", async () => {
    mockFetch({
      "/oauth/access_token": (url) => ({ access_token: url.searchParams.get("grant_type") === "fb_exchange_token" ? "LONG" : "SHORT", expires_in: 5184000 }),
      "/me/accounts": () => ({
        data: [
          {
            id: "page1",
            name: "Meine Seite",
            access_token: "PAGE1",
            picture: { data: { url: "https://img/p1.jpg" } },
            instagram_business_account: { id: "ig1", username: "founder", name: "Founder", profile_picture_url: "https://img/ig.jpg" },
          },
          { id: "page2", name: "Ohne IG", access_token: "PAGE2" },
        ],
      }),
      "/me": () => ({ id: "user1", name: "Paul" }),
    });
    const candidates = await instagramConnector.exchangeCode({ code: "abc", redirectUri: "http://localhost:3000/api/oauth/meta/callback" });
    expect(candidates.map((c) => `${c.network}:${c.externalId}`)).toEqual(["facebook:page1", "instagram:ig1", "facebook:page2"]);
    const ig = candidates.find((c) => c.network === "instagram")!;
    expect(ig.tokens.accessToken).toBe("PAGE1");
    expect(ig.username).toBe("founder");
    expect(ig.meta?.pageId).toBe("page1");
  });

  it("liest Instagram-Tageswerte und entfernt nicht unterstützte Metriken automatisch", async () => {
    let insightCalls = 0;
    mockFetch({
      [`/${ctx.externalId}/insights`]: (url) => {
        insightCalls++;
        const metric = url.searchParams.get("metric") ?? "";
        if (url.searchParams.get("metric_type") === "total_value") {
          if (metric.includes("website_clicks")) {
            return new Response(JSON.stringify({ error: { message: "(#100) The following metrics (website_clicks) should be specified with parameter metric_type=total_value", code: 100 } }), { status: 400 });
          }
          return { data: metric.split(",").map((m) => ({ name: m, period: "day", total_value: { value: m === "views" ? 500 : 7 } })) };
        }
        return {
          data: [
            { name: "reach", period: "day", values: [{ value: 120, end_time: "2026-10-02T07:00:00+0000" }] },
            { name: "follower_count", period: "day", values: [{ value: 3, end_time: "2026-10-02T07:00:00+0000" }] },
          ],
        };
      },
      [`/${ctx.externalId}`]: () => ({ followers_count: 1234, follows_count: 10, media_count: 42 }),
    });
    const points = await instagramConnector.syncAccount(ctx, { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-01T23:59:59Z") });
    const byMetric = Object.fromEntries(points.map((p) => [`${p.metric}@${p.date}`, p.value]));
    expect(byMetric[`followers@${new Date().toISOString().slice(0, 10)}`]).toBe(1234);
    expect(byMetric["reach@2026-10-01"]).toBe(120);
    expect(byMetric["followers_change@2026-10-01"]).toBe(3);
    expect(byMetric["views@2026-10-01"]).toBe(500);
    expect(byMetric["website_clicks@2026-10-01"]).toBeUndefined();
    expect(insightCalls).toBeGreaterThanOrEqual(3); // Zeitreihe + fehlgeschlagener + erfolgreicher Total-Aufruf
  });

  it("veröffentlicht ein Reel über Container → Status → Publish", async () => {
    let statusPolls = 0;
    const calls = mockFetch({
      "/media_publish": () => ({ id: "media_123" }),
      [`/${ctx.externalId}/media`]: (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("media_type")).toBe("REELS");
        expect(body.get("video_url")).toBe("https://example.com/v.mp4");
        expect(body.get("caption")).toBe("Hallo Welt");
        return { id: "container_1" };
      },
      "/container_1": () => ({ status_code: ++statusPolls < 2 ? "IN_PROGRESS" : "FINISHED" }),
      "/media_123": () => ({ permalink: "https://www.instagram.com/reel/abc/" }),
    });
    vi.useFakeTimers();
    const pending = instagramConnector.publishVideo(ctx, {
      filePath: "/tmp/v.mp4",
      publicUrl: "https://example.com/v.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      text: "Hallo Welt",
      options: { kind: "reel" },
    });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    vi.useRealTimers();
    expect(result.status).toBe("published");
    expect(result.externalId).toBe("media_123");
    expect(result.permalink).toContain("instagram.com/reel");
    expect(calls.filter((c) => c.includes("media_publish"))).toHaveLength(1);
  });

  it("liest Facebook-Seiten-Insights mit Umbenennung", async () => {
    mockFetch({
      "/page1/insights": () => ({
        data: [
          { name: "page_impressions", values: [{ value: 900, end_time: "2026-10-02T07:00:00+0000" }] },
          { name: "page_fan_adds", values: [{ value: 5, end_time: "2026-10-02T07:00:00+0000" }] },
        ],
      }),
      "/page1": () => ({ fan_count: 500, followers_count: 520 }),
    });
    const points = await facebookConnector.syncAccount({ ...ctx, network: "facebook", externalId: "page1" }, { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-01T23:59:59Z") });
    expect(points.find((p) => p.metric === "impressions")?.value).toBe(900);
    expect(points.find((p) => p.metric === "likes_gained")?.value).toBe(5);
    expect(points.find((p) => p.metric === "followers")?.value).toBe(520);
  });
});
