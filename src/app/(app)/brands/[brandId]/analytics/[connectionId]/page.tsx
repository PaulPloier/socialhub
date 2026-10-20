import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardTitle, Empty, formatDate, formatNumber, statusColor, statusLabel } from "@/components/ui";
import { NetworkBadge } from "@/components/network-badge";
import { TimeSeriesChart, HorizontalBars } from "@/components/charts";
import { SyncButton } from "@/components/sync-button";
import { getConnection } from "@/lib/services/connections";
import { connectorFor } from "@/lib/connectors/registry";
import { audience, defaultPeriod, kpis, postsWithMetrics, timeseries, type Period } from "@/lib/services/analytics";

export const dynamic = "force-dynamic";

const DIMENSION_LABELS: Record<string, string> = {
  age_gender: "Alter & Geschlecht",
  country: "Länder",
  city: "Städte",
  engaged_age_gender: "Interagierende: Alter & Geschlecht",
  engaged_country: "Interagierende: Länder",
  traffic_source: "Traffic-Quellen",
  device: "Geräte",
  subscribed_status: "Abonniert / nicht abonniert",
  locale: "Sprachen",
  region: "Regionen",
  industry: "Branchen",
  seniority: "Karrierestufen",
  function: "Funktionen",
  company_size: "Unternehmensgrößen",
};

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ brandId: string; connectionId: string }>;
  searchParams: Promise<{ days?: string; from?: string; to?: string; sort?: string }>;
}) {
  const { brandId, connectionId } = await params;
  const sp = await searchParams;
  const conn = await getConnection(connectionId);
  if (!conn || conn.brandId !== brandId) notFound();
  const connector = connectorFor(conn.network);
  const period: Period = sp.from && sp.to ? { from: sp.from, to: sp.to } : defaultPeriod(Number(sp.days ?? 28) || 28);
  const days = Number(sp.days ?? 28) || 28;

  const seriesMetrics = connector.accountMetrics.filter((m) => m.aggregation === "sum").slice(0, 4);
  const [kpiRows, series, posts, aud] = await Promise.all([
    kpis(conn, period),
    timeseries(
      conn.id,
      seriesMetrics.map((m) => m.key),
      period,
    ),
    postsWithMetrics(conn.id, { period, limit: 100, sortBy: sp.sort }),
    audience(conn.id),
  ]);
  const followerSeries = await timeseries(conn.id, ["followers", "subscribers"], period);
  const postColumns = connector.postMetrics.slice(0, 7);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/brands/${brandId}`} className="text-sm text-zinc-500 hover:underline">
            ← Konten
          </Link>
          <NetworkBadge network={conn.network} />
          <h2 className="text-lg font-semibold">{conn.name}</h2>
          <Badge color={statusColor[conn.status]}>{statusLabel[conn.status]}</Badge>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {[7, 28, 90].map((d) => (
            <Link key={d} href={`?days=${d}`} className={`rounded-md px-2.5 py-1 ${days === d && !sp.from ? "bg-zinc-900 text-white" : "bg-white border border-zinc-300 text-zinc-700"}`}>
              {d} Tage
            </Link>
          ))}
          <SyncButton connectionId={conn.id} />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Zeitraum {period.from} bis {period.to} · Letzter Sync {formatDate(conn.lastSyncAt)} · Vergleich mit der Vorperiode
      </p>

      {kpiRows.length === 0 ? <Empty>Noch keine Daten. Der erste Sync läuft nach dem Verbinden automatisch (bis zu einige Minuten).</Empty> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {kpiRows.map((k) => (
          <Card key={k.metric} className="p-4">
            <div className="truncate text-xs text-zinc-500" title={k.label}>
              {k.label}
            </div>
            <div className="mt-1 text-xl font-semibold">{formatNumber(k.value)}</div>
            <div className="text-xs text-zinc-500">
              {k.changePct !== null ? (
                <span className={k.changePct >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {k.changePct >= 0 ? "+" : ""}
                  {k.changePct.toFixed(1)} %
                </span>
              ) : (
                "–"
              )}{" "}
              <span className="text-zinc-400">vs. {formatNumber(k.previous)}</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Verlauf</CardTitle>
          <TimeSeriesChart data={series} series={seriesMetrics.map((m) => ({ key: m.key, label: m.label }))} />
        </Card>
        <Card>
          <CardTitle>{conn.network === "youtube" ? "Abonnenten" : "Follower"}</CardTitle>
          <TimeSeriesChart data={followerSeries} series={[{ key: conn.network === "youtube" ? "subscribers" : "followers", label: conn.network === "youtube" ? "Abonnenten" : "Follower" }]} />
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Beiträge ({posts.length})</CardTitle>
          <div className="text-xs text-zinc-500">
            Sortieren:{" "}
            {postColumns.slice(0, 4).map((m) => (
              <Link key={m.key} href={`?days=${days}&sort=${m.key}`} className={`ml-2 ${sp.sort === m.key ? "font-semibold text-zinc-900" : "underline"}`}>
                {m.label}
              </Link>
            ))}
          </div>
        </div>
        {posts.length === 0 ? (
          <Empty>Keine Beiträge im Zeitraum.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
                  <th className="py-2 pr-3">Datum</th>
                  <th className="py-2 pr-3">Beitrag</th>
                  {postColumns.map((m) => (
                    <th key={m.key} className="py-2 pr-3 text-right">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-b border-zinc-100 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-zinc-500">{p.publishedAt.toLocaleDateString("de-AT")}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-start gap-2">
                        {p.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.thumbnailUrl} alt="" className="h-10 w-10 flex-none rounded object-cover" />
                        ) : null}
                        <div className="min-w-[200px] max-w-md">
                          <div className="line-clamp-2 text-zinc-800">{p.title ?? p.caption ?? "(ohne Text)"}</div>
                          <div className="text-xs text-zinc-400">
                            {p.type}
                            {p.permalink ? (
                              <>
                                {" · "}
                                <a href={p.permalink} target="_blank" rel="noreferrer" className="underline">
                                  öffnen
                                </a>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>
                    {postColumns.map((m) => (
                      <td key={m.key} className="py-2 pr-3 text-right tabular-nums">
                        {formatNumber(p.metrics[m.key] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div>
        <h3 className="mb-3 text-base font-semibold">Zielgruppe</h3>
        {Object.keys(aud).length === 0 ? (
          <Empty>
            {connector.audienceDimensions.length === 0 ? "Dieses Netzwerk liefert über die API keine Zielgruppen-Daten." : "Noch keine Zielgruppen-Daten (nach dem ersten Sync verfügbar; Meta liefert sie erst ab 100 Followern)."}
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(aud).map(([dim, rows]) => (
              <Card key={dim}>
                <CardTitle>{DIMENSION_LABELS[dim] ?? dim}</CardTitle>
                <HorizontalBars data={rows.slice(0, 12)} />
              </Card>
            ))}
          </div>
        )}
      </div>

      <Card>
        <CardTitle>Hinweise zu {connector.label}</CardTitle>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600">
          {connector.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
