import { NextResponse, type NextRequest } from "next/server";
import { isProvider } from "@/lib/connectors/registry";
import { connectSelected, handleCallback } from "@/lib/oauth/flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  try {
    const result = await handleCallback(provider, {
      code: sp.get("code") ?? undefined,
      state: sp.get("state") ?? undefined,
      error: sp.get("error") ?? sp.get("error_code") ?? undefined,
      error_description: sp.get("error_description") ?? sp.get("error_message") ?? undefined,
    });
    if (result.candidates.length === 1) {
      const c = result.candidates[0];
      const done = await connectSelected(result.selectionToken, [`${c.network}:${c.externalId}`]);
      return NextResponse.redirect(new URL(`/oauth/done?connected=${done.connected}`, req.url));
    }
    return NextResponse.redirect(new URL(`/oauth/select?token=${encodeURIComponent(result.selectionToken)}`, req.url));
  } catch (err) {
    return NextResponse.redirect(new URL(`/oauth/done?error=${encodeURIComponent((err as Error).message)}`, req.url));
  }
}
