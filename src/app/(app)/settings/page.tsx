import { deleteApiKeyAction } from "@/app/actions";
import { Badge, Button, Card, CardTitle, PageHeader, formatDate, statusColor, statusLabel } from "@/components/ui";
import { ApiKeyForm } from "@/components/api-key-form";
import { listApiKeys } from "@/lib/auth/api-key";
import { configuredNetworks, env, workerRunsInApp } from "@/lib/env";
import { dbKind, getDb } from "@/lib/db";
import { allConnectors } from "@/lib/connectors/registry";
import { recentJobs } from "@/lib/jobs/queue";
import { redirectUri } from "@/lib/oauth/flow";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await getDb();
  const e = env();
  const configured = configuredNetworks();
  const [keys, jobs] = await Promise.all([listApiKeys(), recentJobs(25)]);
  const mcpUrl = `${e.APP_URL}/api/mcp`;
  const providers = [...new Map(allConnectors().map((c) => [c.provider, c])).values()];

  return (
    <>
      <PageHeader title="Einstellungen & MCP" subtitle="Plattform-Status, API-Keys für Claude und die Job-Queue." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Claude verbinden (MCP)</CardTitle>
          <p className="text-sm text-zinc-600">
            SocialHub stellt einen MCP-Server über HTTP bereit. Jede Funktion der App (Analytics, Reports, Publishing) ist als Tool verfügbar, damit Claude autonom arbeiten kann.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-xs text-zinc-500">Server-URL</dt>
              <dd>
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{mcpUrl}</code>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Authentifizierung</dt>
              <dd>
                Header <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">Authorization: Bearer &lt;API-Key&gt;</code>
              </dd>
            </div>
          </dl>
          <div className="mt-4 rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">
            <div className="text-zinc-400"># Claude Code</div>
            <pre className="whitespace-pre-wrap">{`claude mcp add --transport http socialhub ${mcpUrl} --header "Authorization: Bearer <API-Key>"`}</pre>
            <div className="mt-2 text-zinc-400"># Claude Desktop / claude.ai (Custom Connector) ohne Header-Option</div>
            <pre className="whitespace-pre-wrap">{`npx -y mcp-remote ${mcpUrl} --header "Authorization: Bearer <API-Key>"`}</pre>
          </div>
          <p className="mt-3 text-xs text-zinc-500">Beispiel-Auftrag an Claude: „Hole die neuesten Analytics für f0under.daily, schreib mir einen Wochenbericht und lade in der Zwischenzeit das Video XYZ als Reel auf Instagram hoch mit passender Beschreibung.“</p>
        </Card>

        <Card>
          <CardTitle>API-Keys</CardTitle>
          <ApiKeyForm />
          <ul className="mt-4 divide-y divide-zinc-100 text-sm">
            {e.MCP_API_KEY ? (
              <li className="flex items-center justify-between py-2">
                <span>
                  MCP_API_KEY aus .env <span className="text-xs text-zinc-500">(Bootstrap-Key)</span>
                </span>
                <Badge color="green">aktiv</Badge>
              </li>
            ) : null}
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <div>
                    {k.name} <code className="text-xs text-zinc-500">{k.prefix}…</code>
                  </div>
                  <div className="text-xs text-zinc-500">
                    erstellt {formatDate(k.createdAt)} · zuletzt genutzt {formatDate(k.lastUsedAt)}
                  </div>
                </div>
                <form action={deleteApiKeyAction}>
                  <input type="hidden" name="id" value={k.id} />
                  <Button type="submit" variant="ghost" size="sm" className="text-red-600">
                    Widerrufen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle>Plattform-Apps</CardTitle>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1">Plattform</th>
                <th className="py-1">Status</th>
                <th className="py-1">Redirect-URI (in der Entwickler-Konsole eintragen)</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((c) => {
                const ok = configured[c.network];
                return (
                  <tr key={c.provider} className="border-t border-zinc-100">
                    <td className="py-2">{c.provider === "meta" ? "Meta (Facebook + Instagram)" : c.label}</td>
                    <td className="py-2">
                      <Badge color={ok ? "green" : "zinc"}>{ok ? "konfiguriert" : "fehlt"}</Badge>
                    </td>
                    <td className="py-2">
                      <code className="text-xs">{redirectUri(c.provider)}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-500">Zugangsdaten werden in der .env hinterlegt (siehe README). Nach Änderungen die App neu starten.</p>
        </Card>

        <Card>
          <CardTitle>System</CardTitle>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Datenbank</dt>
            <dd>{dbKind() === "postgres" ? "Postgres" : "PGlite (eingebettet)"}</dd>
            <dt className="text-zinc-500">Worker</dt>
            <dd>{workerRunsInApp() ? "läuft im App-Prozess" : "separater Prozess (npm run worker)"}</dd>
            <dt className="text-zinc-500">Medien</dt>
            <dd>{e.MEDIA_STORAGE === "s3" ? `S3 (${e.S3_BUCKET})` : `lokal (${e.DATA_DIR}/media)`}</dd>
            <dt className="text-zinc-500">Sync-Intervall</dt>
            <dd>alle {e.SYNC_INTERVAL_MINUTES} Minuten</dd>
            <dt className="text-zinc-500">APP_URL</dt>
            <dd className="truncate">{e.APP_URL}</dd>
          </dl>
          <h3 className="mt-5 mb-2 text-sm font-semibold">Letzte Jobs</h3>
          <ul className="max-h-72 space-y-1 overflow-auto text-xs">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 rounded bg-zinc-50 px-2 py-1">
                <span className="font-mono">{j.type}</span>
                <span className="flex items-center gap-2">
                  <Badge color={statusColor[j.status]}>{statusLabel[j.status]}</Badge>
                  <span className="text-zinc-500">{formatDate(j.updatedAt)}</span>
                </span>
                {j.lastError ? <span className="w-full truncate text-red-600" title={j.lastError}>{j.lastError}</span> : null}
              </li>
            ))}
            {jobs.length === 0 ? <li className="text-zinc-500">Noch keine Jobs.</li> : null}
          </ul>
        </Card>
      </div>
    </>
  );
}
