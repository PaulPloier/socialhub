import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tiktokConnector } from "./tiktok";
import type { ConnectionContext } from "./types";

afterEach(() => vi.unstubAllGlobals());

const ctx: ConnectionContext = { id: "c", brandId: "b", network: "tiktok", externalId: "open1", name: "Creator", accessToken: "T", refreshToken: "R", scopes: [], meta: { username: "creator" } };

describe("TikTok connector", () => {
  it("baut die Login-URL mit PKCE", () => {
    const url = new URL(tiktokConnector.authorizationUrl({ state: "s1", redirectUri: "http://localhost:3000/api/oauth/tiktok/callback", codeChallenge: "CH" }));
    expect(url.hostname).toBe("www.tiktok.com");
    expect(url.searchParams.get("client_key")).toBe("tk");
    expect(url.searchParams.get("code_challenge")).toBe("CH");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("video.publish");
  });

  it("lädt ein Video per FILE_UPLOAD in einem Chunk hoch und pollt den Status", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-")), "v.mp4");
    fs.writeFileSync(file, Buffer.alloc(1024 * 10, 1));
    const seen: string[] = [];
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method} ${url.pathname}`);
        const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
        if (url.pathname.includes("creator_info")) return json({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], max_video_post_duration_sec: 600 }, error: { code: "ok" } });
        if (url.pathname.includes("/video/init/")) {
          const body = JSON.parse(String(init?.body));
          expect(body.post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
          expect(body.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 10240, chunk_size: 10240, total_chunk_count: 1 });
          return json({ data: { publish_id: "pub1", upload_url: "https://upload.tiktok.test/u" }, error: { code: "ok" } });
        }
        if (url.hostname === "upload.tiktok.test") {
          const headers = init?.headers as Record<string, string>;
          expect(headers["content-range"]).toBe("bytes 0-10239/10240");
          return new Response(null, { status: 201 });
        }
        if (url.pathname.includes("status/fetch")) {
          polls++;
          return json({ data: polls < 2 ? { status: "PROCESSING_UPLOAD" } : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7001] }, error: { code: "ok" } });
        }
        return json({ error: { code: "x", message: "unexpected" } }, 404);
      }),
    );
    const first = await tiktokConnector.publishVideo(ctx, { filePath: file, publicUrl: "http://x/v", mimeType: "video/mp4", sizeBytes: 10240, text: "Hi", options: { privacyLevel: "PUBLIC_TO_EVERYONE" } });
    expect(first.status).toBe("processing");
    const second = await tiktokConnector.checkPublishStatus!(ctx, first);
    expect(second.status).toBe("published");
    expect(second.permalink).toBe("https://www.tiktok.com/@creator/video/7001");
    expect(seen.some((s) => s.includes("/video/init/"))).toBe(true);
  });

  it("fällt auf SELF_ONLY zurück, wenn die App nicht auditiert ist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
        if (url.pathname.includes("creator_info")) return json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } });
        if (url.pathname.includes("/video/init/")) {
          expect(JSON.parse(String(init?.body)).post_info.privacy_level).toBe("SELF_ONLY");
          return json({ error: { code: "spam_risk", message: "blocked" } });
        }
        return json({});
      }),
    );
    await expect(tiktokConnector.publishVideo(ctx, { filePath: "/dev/null", publicUrl: "", mimeType: "video/mp4", sizeBytes: 0, text: "", options: {} })).rejects.toThrow(/spam_risk/);
  });
});
