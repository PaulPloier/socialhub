import "server-only";
import { Readable } from "node:stream";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Media } from "../db/schema";
import { safeFilename, storage } from "../storage";

const ALLOWED = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "image/jpeg", "image/png"]);

export function assertAllowedMime(mime: string) {
  if (!ALLOWED.has(mime)) throw new Error(`Dateityp ${mime} wird nicht unterstützt. Erlaubt: MP4, MOV, WebM, JPG, PNG.`);
}

export async function saveMedia(brandId: string, filename: string, mimeType: string, source: Readable | Buffer): Promise<Media> {
  assertAllowedMime(mimeType);
  const db = await getDb();
  const id = crypto.randomUUID();
  const key = `${brandId}/${id}-${safeFilename(filename)}`;
  const stored = await storage().put(key, source, mimeType);
  const [row] = await db
    .insert(schema.media)
    .values({ id, brandId, filename, mimeType, sizeBytes: stored.sizeBytes, storageKey: stored.storageKey })
    .returning();
  return row;
}

/** Lädt eine Datei von einer öffentlichen URL in die Medienbibliothek (für Claude über MCP). */
export async function importMediaFromUrl(brandId: string, url: string, filename?: string): Promise<Media> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen: ${res.status}`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim() || guessMime(url);
  const name = filename ?? decodeURIComponent(new URL(url).pathname.split("/").pop() || "video.mp4");
  const stream = Readable.fromWeb(res.body as never);
  return saveMedia(brandId, name, mime, stream);
}

function guessMime(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return "video/mp4";
}

export async function listMedia(brandId: string): Promise<Media[]> {
  const db = await getDb();
  return db.query.media.findMany({ where: eq(schema.media.brandId, brandId), orderBy: desc(schema.media.createdAt) });
}

export async function getMedia(id: string): Promise<Media | undefined> {
  const db = await getDb();
  return db.query.media.findFirst({ where: eq(schema.media.id, id) });
}

export async function deleteMedia(id: string): Promise<void> {
  const db = await getDb();
  const m = await getMedia(id);
  if (!m) return;
  await storage().delete(m.storageKey);
  await db.delete(schema.media).where(eq(schema.media.id, id));
}

export async function mediaLocalPath(m: Media): Promise<string> {
  return storage().localPath(m.storageKey);
}

export function mediaPublicUrl(m: Media): string {
  return storage().publicUrl(m.storageKey, m.id);
}
