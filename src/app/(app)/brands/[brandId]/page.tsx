import Link from "next/link";
import { deleteBrandAction, deleteConnectionAction, syncBrandAction } from "@/app/actions";
import { Badge, Button, Card, CardTitle, Empty, formatDate, formatNumber, statusColor, statusLabel } from "@/components/ui";
import { NetworkBadge } from "@/components/network-badge";
import { ConnectButton } from "@/components/connect-button";
import { SyncButton } from "@/components/sync-button";
import { configuredNetworks } from "@/lib/env";
import { PROVIDERS, PROVIDER_LABELS, connectorsForProvider } from "@/lib/connectors/registry";
import { listConnections } from "@/lib/services/connections";
import { brandOverview, defaultPeriod } from "@/lib/services/analytics";

export const dynamic = "force-dynamic";

export default async function BrandPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<{ connect?: string }> }) {
  const { brandId } = await params;
  const { connect } = await searchParams;
  const configured = configuredNetworks();
  const connections = await listConnections(brandId);
  const period = defaultPeriod(28);
  const overview = connections.length ? await brandOverview(brandId, period, 3) : [];

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Konto verbinden</h2>
          {connections.length ? (
            <form action={syncBrandAction}>
              <input type="hidden" name="brandId" value={brandId} />
              <Button type="submit" variant="secondary" size="sm">
                Alle Konten synchronisieren
              </Button>
            </form>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => {
            const networks = connectorsForProvider(p).map((c) => c.network);
            const ok = networks.every((n) => configured[n]);
            return (
              <div key={p} className="flex items-center gap-2">
                <ConnectButton brandId={brandId} provider={p} label={`${PROVIDER_LABELS[p]} verbinden`} disabled={!ok} autoOpen={connect === p && ok} />
                {!ok ? <span className="text-xs text-zinc-400">nicht konfiguriert</span> : null}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Der Login läuft in einem Popup direkt bei der Plattform. SocialHub sieht kein Passwort, nur das Zugriffs-Token, das verschlüsselt gespeichert wird.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">Verbundene Konten (letzte 28 Tage)</h2>
        {connections.length === 0 ? <Empty>Noch kein Konto verbunden.</Empty> : null}
        <div className="grid gap-4 md:grid-cols-2">
          {overview.map((o) => {
            const c = o.connection;
            const headline = o.kpis.filter((k) => k.value !== null).slice(0, 4);
            return (
              <Card key={c.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {c.pictureUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.pictureUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-zinc-200" />
                    )}
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <NetworkBadge network={c.network} />
                        {c.username ? <span>@{c.username}</span> : null}
                      </div>
                    </div>
                  </div>
                  <Badge color={statusColor[c.status]}>{statusLabel[c.status]}</Badge>
                </div>
                {c.statusMessage ? <p className="mt-2 text-xs text-red-700">{c.statusMessage}</p> : null}
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {headline.map((k) => (
                    <div key={k.metric}>
                      <dt className="text-xs text-zinc-500">{k.label}</dt>
                      <dd className="text-lg font-semibold">{formatNumber(k.value)}</dd>
                      {k.changePct !== null ? (
                        <dd className={`text-xs ${k.changePct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {k.changePct >= 0 ? "+" : ""}
                          {k.changePct.toFixed(1)} %
                        </dd>
                      ) : null}
                    </div>
                  ))}
                  {headline.length === 0 ? <div className="col-span-full text-sm text-zinc-400">Noch keine Daten (Sync läuft oder steht aus).</div> : null}
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>Letzter Sync: {formatDate(c.lastSyncAt)}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link href={`/brands/${brandId}/analytics/${c.id}`} className="inline-flex h-8 items-center rounded-md bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700">
                    Analytics
                  </Link>
                  <SyncButton connectionId={c.id} />
                  <form action={deleteConnectionAction}>
                    <input type="hidden" name="connectionId" value={c.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-red-600">
                      Trennen
                    </Button>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section>
        <Card className="border-red-100">
          <CardTitle className="text-red-700">Gefahrenzone</CardTitle>
          <form action={deleteBrandAction}>
            <input type="hidden" name="brandId" value={brandId} />
            <Button type="submit" variant="danger" size="sm">
              Brand mit allen Konten und Daten löschen
            </Button>
          </form>
        </Card>
      </section>
    </div>
  );
}
