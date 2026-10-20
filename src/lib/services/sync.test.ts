import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "../db";
import { encrypt } from "../crypto";
import { replaceAudience, upsertMetrics, upsertPosts } from "./sync";
import { audience, kpis, postsWithMetrics, timeseries } from "./analytics";
import type { PostRecord } from "../connectors/types";

let connectionId: string;

beforeAll(async () => {
  const db = await getDb();
  const brandId = crypto.randomUUID();
  await db.insert(schema.brands).values({ id: brandId, name: "Test", slug: `test-${brandId.slice(0, 6)}` });
  connectionId = crypto.randomUUID();
  await db.insert(schema.connections).values({
    id: connectionId,
    brandId,
    network: "instagram",
    externalId: "ig1",
    name: "Testkonto",
    accessTokenEnc: encrypt("token"),
  });
});

describe("sync upserts", () => {
  it("schreibt Tageswerte idempotent und berechnet KPIs", async () => {
    const n1 = await upsertMetrics(connectionId, [
      { metric: "views", date: "2026-10-01", value: 100 },
      { metric: "views", date: "2026-10-02", value: 150 },
      { metric: "followers", date: "2026-10-02", value: 1000 },
      { metric: "views", date: "2026-10-02", value: 160 }, // letzter Wert gewinnt
    ]);
    expect(n1).toBe(3);
    await upsertMetrics(connectionId, [{ metric: "views", date: "2026-10-02", value: 170 }]);
    const series = await timeseries(connectionId, ["views", "followers"], { from: "2026-10-01", to: "2026-10-02" });
    expect(series).toEqual([
      { date: "2026-10-01", views: 100 },
      { date: "2026-10-02", views: 170, followers: 1000 },
    ]);
    const db = await getDb();
    const conn = (await db.query.connections.findFirst())!;
    const k = await kpis({ ...conn, id: connectionId }, { from: "2026-10-01", to: "2026-10-02" });
    expect(k.find((x) => x.metric === "views")?.value).toBe(270);
    expect(k.find((x) => x.metric === "followers")?.value).toBe(1000);
  });

  it("legt Posts an, aktualisiert sie und liefert den letzten Metrik-Stand", async () => {
    const posts: PostRecord[] = [
      { externalId: "p1", type: "reel", caption: "Erster", publishedAt: new Date("2026-10-01T10:00:00Z"), metrics: { views: 10, likes: 2 } },
      { externalId: "p2", type: "feed", caption: "Zweiter", publishedAt: new Date("2026-10-02T10:00:00Z"), metrics: { views: 50 } },
    ];
    expect(await upsertPosts(connectionId, posts)).toBe(2);
    posts[0].metrics.views = 99;
    posts[0].caption = "Erster (bearbeitet)";
    expect(await upsertPosts(connectionId, posts)).toBe(2);
    const rows = await postsWithMetrics(connectionId, { sortBy: "views" });
    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).toBe("p1");
    expect(rows[0].metrics.views).toBe(99);
    expect(rows[0].caption).toBe("Erster (bearbeitet)");
  });

  it("ersetzt Zielgruppen-Dimensionen vollständig", async () => {
    await replaceAudience(connectionId, [
      { dimension: "country", key: "AT", value: 60 },
      { dimension: "country", key: "DE", value: 40 },
      { dimension: "age_gender", key: "25-34|F", value: 30 },
    ]);
    await replaceAudience(connectionId, [{ dimension: "country", key: "AT", value: 70 }]);
    const a = await audience(connectionId);
    expect(a.country).toEqual([{ key: "AT", value: 70 }]);
    expect(a.age_gender).toEqual([{ key: "25-34|F", value: 30 }]);
  });
});
