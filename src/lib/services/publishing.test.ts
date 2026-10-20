import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, schema } from "../db";
import { encrypt } from "../crypto";
import { saveMedia } from "./media";
import type { Connector, PublishResult } from "../connectors/types";

const publishVideo = vi.fn<Connector["publishVideo"]>();
const checkPublishStatus = vi.fn<NonNullable<Connector["checkPublishStatus"]>>();

vi.mock("../connectors/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../connectors/registry")>();
  return {
    ...real,
    connectorFor: (network: string) => {
      const base = real.connectorFor(network as never);
      return { ...base, publishVideo, checkPublishStatus };
    },
  };
});

const { cancelScheduledPost, checkTarget, createScheduledPost, getScheduledPost, publishTarget } = await import("./publishing");
const { claimNext } = await import("../jobs/queue");

let brandId: string;
let ytConn: string;
let igConn: string;
let mediaId: string;

beforeAll(async () => {
  const db = await getDb();
  brandId = crypto.randomUUID();
  await db.insert(schema.brands).values({ id: brandId, name: "Pub", slug: `pub-${brandId.slice(0, 6)}` });
  ytConn = crypto.randomUUID();
  igConn = crypto.randomUUID();
  await db.insert(schema.connections).values([
    { id: ytConn, brandId, network: "youtube", externalId: "UC1", name: "Kanal", accessTokenEnc: encrypt("t"), tokenExpiresAt: new Date(Date.now() + 3600_000) },
    { id: igConn, brandId, network: "instagram", externalId: "ig1", name: "IG", accessTokenEnc: encrypt("t") },
  ]);
  const m = await saveMedia(brandId, "clip.mp4", "video/mp4", Buffer.from("fake-video-bytes"));
  mediaId = m.id;
});

describe("publishing", () => {
  it("lehnt ungültige Optionen und fremde Verbindungen ab", async () => {
    await expect(createScheduledPost({ brandId, mediaId, text: "x", targets: [] })).rejects.toThrow(/Zielkonto/);
    await expect(createScheduledPost({ brandId, mediaId, text: "x", targets: [{ connectionId: "fremd" }] })).rejects.toThrow(/gehört nicht/);
    await expect(createScheduledPost({ brandId, mediaId, text: "x", targets: [{ connectionId: ytConn, options: { privacyStatus: "geheim" } }] })).rejects.toThrow(/privacyStatus/);
  });

  it("legt Post, Ziele und Jobs an und veröffentlicht über den Worker-Handler", async () => {
    publishVideo.mockImplementation(async (ctx, input) => {
      expect(input.text).toBe("Hallo");
      expect(input.sizeBytes).toBe(16);
      expect(input.publicUrl).toContain("/api/media/");
      if (ctx.network === "youtube") return { externalId: "yt1", permalink: "https://youtu.be/yt1", status: "published" } satisfies PublishResult;
      return { externalId: "container", status: "processing", raw: { containerId: "container" } } satisfies PublishResult;
    });
    const post = await createScheduledPost({
      brandId,
      mediaId,
      text: "Hallo",
      title: "Titel",
      targets: [
        { connectionId: ytConn, options: { privacyStatus: "unlisted", tags: ["a", "b"] } },
        { connectionId: igConn, options: { kind: "reel" } },
      ],
    });
    expect(post.status).toBe("scheduled");
    expect(post.targets).toHaveLength(2);
    expect(post.targets.find((t) => t.network === "youtube")?.options).toMatchObject({ privacyStatus: "unlisted", tags: ["a", "b"], categoryId: "22" });

    // Zwei publish.target-Jobs wurden eingereiht
    const jobs: string[] = [];
    for (let j = await claimNext(); j; j = await claimNext()) {
      if (j.type === "publish.target") {
        await publishTarget(String(j.payload.targetId));
        jobs.push(j.id);
      }
    }
    expect(jobs).toHaveLength(2);

    const after = (await getScheduledPost(post.id))!;
    const yt = after.targets.find((t) => t.network === "youtube")!;
    const ig = after.targets.find((t) => t.network === "instagram")!;
    expect(yt.status).toBe("published");
    expect(yt.permalink).toBe("https://youtu.be/yt1");
    expect(ig.status).toBe("processing");
    expect(after.status).toBe("publishing");

    // Nachkontrolle des Instagram-Containers → fertig
    checkPublishStatus.mockResolvedValue({ externalId: "media9", permalink: "https://instagram.com/reel/x", status: "published" });
    expect(await checkTarget(ig.id)).toBe("published");
    const done = (await getScheduledPost(post.id))!;
    expect(done.status).toBe("published");
    expect(done.targets.find((t) => t.network === "instagram")?.externalId).toBe("media9");
  });

  it("markiert fehlgeschlagene Ziele und den Post als fehlgeschlagen", async () => {
    publishVideo.mockRejectedValue(new Error("Quota exceeded"));
    const post = await createScheduledPost({ brandId, mediaId, text: "x", targets: [{ connectionId: ytConn }] });
    await expect(publishTarget(post.targets[0].id)).rejects.toThrow(/Quota/);
    const after = (await getScheduledPost(post.id))!;
    expect(after.targets[0].status).toBe("failed");
    expect(after.targets[0].error).toContain("Quota");
    expect(after.status).toBe("failed");
  });

  it("storniert geplante Posts", async () => {
    const post = await createScheduledPost({ brandId, mediaId, text: "später", scheduledAt: new Date(Date.now() + 86_400_000), targets: [{ connectionId: ytConn }] });
    await cancelScheduledPost(post.id);
    const after = (await getScheduledPost(post.id))!;
    expect(after.status).toBe("cancelled");
    expect(after.targets[0].status).toBe("cancelled");
    expect(await publishTarget(after.targets[0].id)).toBeNull();
  });
});
