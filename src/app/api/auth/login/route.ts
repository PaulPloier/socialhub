import { NextResponse, type NextRequest } from "next/server";
import { checkPassword, createSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (!checkPassword(password)) {
    return NextResponse.redirect(new URL(`/login?error=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }
  await createSession();
  return NextResponse.redirect(new URL(safeNext, req.url), 303);
}
