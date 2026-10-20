import Link from "next/link";
import { createBrandAction } from "@/app/actions";
import { Button, Card, CardTitle, Empty, Input, Label, PageHeader, formatDate } from "@/components/ui";
import { NetworkDot } from "@/components/network-badge";
import { listBrands } from "@/lib/services/brands";
import { listConnections } from "@/lib/services/connections";
import { configuredNetworks } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [brands, connections] = await Promise.all([listBrands(), listConnections()]);
  const configured = configuredNetworks();
  const configuredCount = Object.values(configured).filter(Boolean).length;
  return (
    <>
      <PageHeader title="Brands" subtitle="Jede Brand bündelt die Social-Konten eines Kunden oder Projekts." />
      {configuredCount === 0 ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Noch keine Plattform-App konfiguriert. Trage in der <code>.env</code> die Zugangsdaten ein (Anleitung im README) und starte die App neu. Status unter{" "}
          <Link href="/settings" className="underline">
            Einstellungen
          </Link>
          .
        </div>
      ) : null}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-4">
          {brands.length === 0 ? <Empty>Noch keine Brand. Lege rechts die erste an.</Empty> : null}
          {brands.map((b) => {
            const conns = connections.filter((c) => c.brandId === b.id);
            return (
              <Link key={b.id} href={`/brands/${b.id}`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-base font-semibold">{b.name}</div>
                      <div className="text-xs text-zinc-500">
                        {conns.length} {conns.length === 1 ? "Konto" : "Konten"} · {b.timezone}
                        {conns.some((c) => c.status === "reauth_required") ? <span className="ml-2 text-red-600">Neu verbinden nötig</span> : null}
                      </div>
                    </div>
                    <div className="flex -space-x-1">
                      {conns.map((c) => (
                        <NetworkDot key={c.id} network={c.network} className="ring-2 ring-white" />
                      ))}
                    </div>
                  </div>
                  {conns.length ? (
                    <div className="mt-3 text-xs text-zinc-500">Letzter Sync: {formatDate(conns.map((c) => c.lastSyncAt).filter(Boolean).sort().at(-1) ?? null)}</div>
                  ) : null}
                </Card>
              </Link>
            );
          })}
        </div>
        <Card>
          <CardTitle>Neue Brand</CardTitle>
          <form action={createBrandAction} className="space-y-3">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="z. B. f0under.daily" required />
            </div>
            <div>
              <Label htmlFor="timezone">Zeitzone</Label>
              <Input id="timezone" name="timezone" defaultValue="Europe/Vienna" />
            </div>
            <Button type="submit" className="w-full">
              Anlegen
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
