import { connectSelectedAction } from "@/app/actions";
import { Button, Card } from "@/components/ui";
import { NetworkBadge } from "@/components/network-badge";
import { loadCandidates } from "@/lib/oauth/flow";
import { PROVIDER_LABELS } from "@/lib/connectors/registry";

export const dynamic = "force-dynamic";

export default async function SelectAccountsPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const loaded = token ? await loadCandidates(token) : null;
  if (!loaded) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-red-700">Auswahl abgelaufen. Bitte die Verbindung erneut starten.</p>
      </main>
    );
  }
  return (
    <main className="flex flex-1 items-start justify-center p-6">
      <Card className="w-full max-w-lg">
        <h1 className="text-lg font-semibold">{PROVIDER_LABELS[loaded.provider]}: Konten auswählen</h1>
        <p className="mb-4 mt-1 text-sm text-zinc-500">Welche Konten sollen mit dieser Brand verbunden werden?</p>
        <form action={connectSelectedAction} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {loaded.candidates.map((c) => (
              <li key={`${c.network}:${c.externalId}`} className="flex items-center gap-3 p-3">
                <input type="checkbox" name="account" value={`${c.network}:${c.externalId}`} defaultChecked className="h-4 w-4" id={`${c.network}-${c.externalId}`} />
                {c.pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.pictureUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
                ) : (
                  <div className="h-9 w-9 rounded-full bg-zinc-200" />
                )}
                <label htmlFor={`${c.network}-${c.externalId}`} className="flex-1 cursor-pointer">
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-zinc-500">{c.username ? `@${c.username}` : c.externalId}</div>
                </label>
                <NetworkBadge network={c.network} />
              </li>
            ))}
          </ul>
          <Button type="submit" className="w-full">
            Ausgewählte Konten verbinden
          </Button>
        </form>
      </Card>
    </main>
  );
}
