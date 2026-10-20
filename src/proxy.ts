import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE = "socialhub_session";

/**
 * Zugriffsschutz für die Web-Oberfläche. API-Routen für OAuth-Callbacks, Medien
 * (werden von den Plattformen abgerufen) und MCP (eigener Bearer-Schutz) bleiben frei.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const open =
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/oauth/") ||
    pathname.startsWith("/api/media/") ||
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/oauth/");
  if (open) return NextResponse.next();

  const token = request.cookies.get(COOKIE)?.value;
  const secret = process.env.AUTH_SECRET;
  let ok = false;
  if (token && secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
