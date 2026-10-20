"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createBrand, deleteBrand, getBrand } from "@/lib/services/brands";
import { deleteConnection, getConnection } from "@/lib/services/connections";
import { enqueue } from "@/lib/jobs/queue";
import { cancelScheduledPost, createScheduledPost } from "@/lib/services/publishing";
import { createApiKey, deleteApiKey } from "@/lib/auth/api-key";
import { connectSelected } from "@/lib/oauth/flow";
import { narrateWithClaude, renderMarkdownReport, reportData, saveReport } from "@/lib/services/reports";
import { defaultPeriod } from "@/lib/services/analytics";
import { deleteMedia } from "@/lib/services/media";

export type ActionResult = { ok: true; message?: string; data?: unknown } | { ok: false; error: string };

function fail(err: unknown): ActionResult {
  return { ok: false, error: (err as Error).message ?? String(err) };
}

export async function createBrandAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const b = await createBrand(name, String(formData.get("timezone") || "Europe/Vienna"));
  redirect(`/brands/${b.id}`);
}

export async function deleteBrandAction(formData: FormData): Promise<void> {
  await deleteBrand(String(formData.get("brandId")));
  redirect("/");
}

export async function deleteConnectionAction(formData: FormData): Promise<void> {
  const id = String(formData.get("connectionId"));
  const conn = await getConnection(id);
  if (!conn) return;
  await deleteConnection(id);
  revalidatePath(`/brands/${conn.brandId}`);
}

export async function syncConnectionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const id = String(formData.get("connectionId"));
    const scope = String(formData.get("scope") || "all") as "all" | "account" | "posts" | "audience";
    const backfill = Number(formData.get("backfillDays") || 0) || undefined;
    const conn = await getConnection(id);
    if (!conn) return { ok: false, error: "Verbindung nicht gefunden" };
    const type = scope === "all" ? "sync.all" : (`sync.${scope}` as const);
    await enqueue(type, { connectionId: id, backfillDays: backfill }, { uniqueKey: `${type}:${id}:manual` });
    revalidatePath(`/brands/${conn.brandId}`);
    return { ok: true, message: "Sync gestartet. Die Daten erscheinen in wenigen Minuten." };
  } catch (err) {
    return fail(err);
  }
}

export async function syncBrandAction(formData: FormData): Promise<void> {
  const brandId = String(formData.get("brandId"));
  const { listConnections } = await import("@/lib/services/connections");
  for (const c of await listConnections(brandId)) {
    await enqueue("sync.all", { connectionId: c.id }, { uniqueKey: `sync.all:${c.id}:manual` });
  }
  revalidatePath(`/brands/${brandId}`);
}

export async function createScheduledPostAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const brandId = String(formData.get("brandId"));
    const targets = JSON.parse(String(formData.get("targets") || "[]")) as { connectionId: string; options?: Record<string, unknown> }[];
    const when = String(formData.get("scheduledAt") || "");
    const tz = String(formData.get("timezone") || "Europe/Vienna");
    const scheduledAt = when ? zonedToDate(when, tz) : null;
    const post = await createScheduledPost({
      brandId,
      mediaId: String(formData.get("mediaId") || "") || null,
      text: String(formData.get("text") ?? ""),
      title: String(formData.get("title") ?? "") || null,
      scheduledAt,
      targets,
      createdBy: "ui",
    });
    revalidatePath(`/brands/${brandId}/publish`);
    return { ok: true, message: scheduledAt ? `Geplant für ${scheduledAt.toLocaleString("de-AT")}` : "Veröffentlichung gestartet.", data: { id: post.id } };
  } catch (err) {
    return fail(err);
  }
}

/** "2026-10-20T14:30" in einer IANA-Zeitzone → Date (UTC). */
function zonedToDate(local: string, timeZone: string): Date {
  const [datePart, timePart = "00:00"] = local.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return new Date(utcGuess - (asIfUtc - utcGuess));
}

export async function cancelScheduledPostAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const brandId = String(formData.get("brandId"));
  await cancelScheduledPost(id);
  revalidatePath(`/brands/${brandId}/publish`);
}

export async function deleteMediaAction(formData: FormData): Promise<void> {
  const brandId = String(formData.get("brandId"));
  await deleteMedia(String(formData.get("mediaId")));
  revalidatePath(`/brands/${brandId}/publish`);
}

export async function createApiKeyAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const name = String(formData.get("name") || "Claude").trim();
    const { plain } = await createApiKey(name);
    revalidatePath("/settings");
    return { ok: true, message: "Key erzeugt. Er wird nur einmal angezeigt.", data: { key: plain } };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteApiKeyAction(formData: FormData): Promise<void> {
  await deleteApiKey(String(formData.get("id")));
  revalidatePath("/settings");
}

export async function connectSelectedAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token"));
  const keys = formData.getAll("account").map(String);
  try {
    const res = await connectSelected(token, keys);
    redirect(`/oauth/done?connected=${res.connected}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/oauth/done?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function generateReportAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const brandId = String(formData.get("brandId"));
    const days = Number(formData.get("days") || 28);
    const brand = await getBrand(brandId);
    if (!brand) return { ok: false, error: "Brand nicht gefunden" };
    const period = defaultPeriod(days);
    const data = await reportData(brandId, period);
    const tables = renderMarkdownReport(brand.name, data);
    const narrative = formData.get("withClaude") ? await narrateWithClaude(tables, brand.name) : null;
    const markdown = narrative ? `${tables.split("\n")[0]}\n\n## Zusammenfassung\n\n${narrative}\n\n${tables.split("\n").slice(1).join("\n")}` : tables;
    const r = await saveReport({ brandId, title: `Report ${period.from} bis ${period.to}`, markdown, period, createdBy: "ui" });
    revalidatePath(`/brands/${brandId}/reports`);
    return { ok: true, data: { id: r.id } };
  } catch (err) {
    return fail(err);
  }
}
