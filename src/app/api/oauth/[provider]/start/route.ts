import { NextResponse, type NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth/session";
import { isProvider } from "@/lib/connectors/registry";
import { startOAuth } from "@/lib/oauth/flow";
import { getBrand } from "@/lib/services/brands";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!(await isAuthenticated())) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`, req.url));
  }
  if (!isProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const brandId = req.nextUrl.searchParams.get("brandId") ?? "";
  const brand = await getBrand(brandId);
  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  try {
    const url = await startOAuth(brand.id, provider);
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.redirect(new URL(`/oauth/done?error=${encodeURIComponent((err as Error).message)}`, req.url));
  }
}
