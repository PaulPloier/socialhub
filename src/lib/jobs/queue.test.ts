import { describe, expect, it } from "vitest";
import { claimNext, complete, enqueue, fail, getJob } from "./queue";

describe("job queue", () => {
  it("reiht Jobs ein, holt sie fällig ab und schließt sie ab", async () => {
    const id = await enqueue("sync.account", { connectionId: "c1" }, { uniqueKey: "test:1" });
    const dup = await enqueue("sync.account", { connectionId: "c1" }, { uniqueKey: "test:1" });
    expect(dup).toBe(id); // idempotent über uniqueKey

    const job = await claimNext();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe("running");
    expect(job?.attempts).toBe(1);

    await complete(job!, { ok: true });
    const done = await getJob(id);
    expect(done?.status).toBe("done");
    expect(done?.result).toEqual({ ok: true });

    // Nach Abschluss kann derselbe uniqueKey erneut eingereiht werden
    const again = await enqueue("sync.account", { connectionId: "c1" }, { uniqueKey: "test:1" });
    expect(again).not.toBe(id);
  });

  it("verschiebt fehlgeschlagene Jobs mit Backoff und gibt nach maxAttempts auf", async () => {
    const id = await enqueue("sync.posts", {}, { uniqueKey: "test:fail", maxAttempts: 2 });
    let job = await claimNext();
    while (job && job.id !== id) {
      await complete(job);
      job = await claimNext();
    }
    expect(job?.id).toBe(id);
    await fail(job!, new Error("boom"));
    let j = await getJob(id);
    expect(j?.status).toBe("queued");
    expect(j?.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(j?.lastError).toContain("boom");

    // Zweiter Versuch (simuliert fällig)
    const { getDb, schema } = await import("../db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, id));
    job = await claimNext();
    expect(job?.id).toBe(id);
    await fail(job!, new Error("boom again"));
    j = await getJob(id);
    expect(j?.status).toBe("failed");
  });

  it("gibt nicht-wiederholbare Fehler sofort auf", async () => {
    const id = await enqueue("token.refresh", {}, { uniqueKey: "test:noretry" });
    let job = await claimNext();
    while (job && job.id !== id) {
      await complete(job);
      job = await claimNext();
    }
    await fail(job!, new Error("auth"), { retry: false });
    expect((await getJob(id))?.status).toBe("failed");
  });
});
