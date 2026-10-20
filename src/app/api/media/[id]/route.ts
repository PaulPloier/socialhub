import fs from "node:fs";
import { Readable } from "node:stream";
import { type NextRequest } from "next/server";
import { getMedia, mediaLocalPath } from "@/lib/services/media";

export const dynamic = "force-dynamic";

/**
 * Liefert eine Mediendatei aus. Öffentlich (ohne Login), weil Instagram, Facebook
 * und andere Plattformen das Video von dieser URL abholen. Die IDs sind UUIDs,
 * damit sie nicht erratbar sind. Unterstützt Range-Requests (Video-Streaming).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const media = await getMedia(id);
  if (!media) return new Response("not found", { status: 404 });
  const file = await mediaLocalPath(media);
  if (!fs.existsSync(file)) return new Response("file missing", { status: 404 });
  const size = fs.statSync(file).size;
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "content-type": media.mimeType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
    "content-disposition": `inline; filename="${media.filename.replace(/"/g, "")}"`,
  };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}

export async function HEAD(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const res = await GET(req, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}
