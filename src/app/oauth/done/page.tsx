import { DoneClient } from "./done-client";

export const dynamic = "force-dynamic";

export default async function OAuthDonePage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  return <DoneClient connected={Number(sp.connected ?? 0)} error={sp.error ?? null} />;
}
