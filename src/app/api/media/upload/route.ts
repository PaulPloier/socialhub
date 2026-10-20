import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import { isAuthenticated } from "@/lib/auth/session";
import { getBrand } from "@/lib/services/brands";
import { saveMedia } from "@/lib/services/media";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Multipart-Upload aus der UI: Feld "file" + "brandId". */
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await req.formData();
  const brandId = String(form.get("brandId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Keine Datei" }, { status: 400 });
  if (!(await getBrand(brandId))) return NextResponse.json({ error: "Brand nicht gefunden" }, { status: 404 });
  try {
    const mime = file.type || (file.name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4");
    const stream = Readable.fromWeb(file.stream() as never);
    const media = await saveMedia(brandId, file.name, mime, stream);
    return NextResponse.json({ id: media.id, filename: media.filename, sizeBytes: media.sizeBytes, mimeType: media.mimeType });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
