import { z } from "zod";
import { cancelScheduledPostAction, deleteMediaAction } from "@/app/actions";
import { Badge, Button, Card, CardTitle, Empty, formatDate, statusColor, statusLabel } from "@/components/ui";
import { NetworkBadge } from "@/components/network-badge";
import { PublishForm, type OptionField } from "@/components/publish-form";
import { UploadForm } from "@/components/upload-form";
import { getBrand } from "@/lib/services/brands";
import { listConnections } from "@/lib/services/connections";
import { listMedia } from "@/lib/services/media";
import { listScheduledPosts } from "@/lib/services/publishing";
import { allConnectors } from "@/lib/connectors/registry";
import type { Network } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Zod-Schema → einfache Feldliste für das Formular. */
function fieldsFromSchema(schema: z.ZodObject<z.ZodRawShape>): OptionField[] {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, Record<string, unknown>> };
  const out: OptionField[] = [];
  for (const [key, prop] of Object.entries(json.properties ?? {})) {
    const p = prop as { type?: string | string[]; enum?: string[]; default?: unknown; description?: string; items?: { type?: string } };
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    let type: OptionField["type"] = "string";
    if (p.enum) type = "enum";
    else if (t === "boolean") type = "boolean";
    else if (t === "number" || t === "integer") type = "number";
    else if (t === "array") type = "array";
    out.push({ key, type, enum: p.enum, default: p.default, description: p.description });
  }
  return out;
}

export default async function PublishPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const brand = await getBrand(brandId);
  const [connections, media, posts] = await Promise.all([listConnections(brandId), listMedia(brandId), listScheduledPosts(brandId, { limit: 30 })]);
  const fields = {} as Record<Network, OptionField[]>;
  const notes = {} as Record<Network, string[]>;
  for (const c of allConnectors()) {
    fields[c.network] = fieldsFromSchema(c.publishOptionsSchema);
    notes[c.network] = c.notes;
  }
  const appUrl = env().APP_URL;
  const localOnly = /localhost|127\.0\.0\.1/.test(appUrl);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {localOnly ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            APP_URL ist <code>{appUrl}</code>. Instagram und Facebook holen Videos per öffentlicher URL ab; dafür muss die App von außen erreichbar sein (z. B. ngrok oder Cloudflare Tunnel, dann APP_URL anpassen). YouTube, TikTok, LinkedIn und X laden direkt hoch und funktionieren auch lokal.
          </div>
        ) : null}
        <Card>
          <CardTitle>Video veröffentlichen</CardTitle>
          <PublishForm
            brandId={brandId}
            timezone={brand?.timezone ?? "Europe/Vienna"}
            connections={connections.map((c) => ({ id: c.id, network: c.network, name: c.name, status: c.status }))}
            media={media.map((m) => ({ id: m.id, filename: m.filename, sizeBytes: m.sizeBytes }))}
            fields={fields}
            notes={notes}
          />
        </Card>

        <Card>
          <CardTitle>Geplante & veröffentlichte Posts</CardTitle>
          {posts.length === 0 ? (
            <Empty>Noch nichts geplant.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {posts.map((p) => (
                <li key={p.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge color={statusColor[p.status]}>{statusLabel[p.status]}</Badge>
                        <span className="text-xs text-zinc-500">{formatDate(p.scheduledAt)}</span>
                        <span className="text-xs text-zinc-400">via {p.createdBy}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-zinc-800">{p.title ? `${p.title} – ` : ""}{p.text || "(ohne Text)"}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {p.targets.map((t) => (
                          <span key={t.id} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs">
                            <NetworkBadge network={t.network as Network} />
                            <span className="text-zinc-600">{t.connectionName}</span>
                            <Badge color={statusColor[t.status]}>{statusLabel[t.status]}</Badge>
                            {t.permalink ? (
                              <a href={t.permalink} target="_blank" rel="noreferrer" className="underline">
                                Link
                              </a>
                            ) : null}
                            {t.error ? <span className="text-red-600" title={t.error}>Fehler</span> : null}
                          </span>
                        ))}
                      </div>
                      {p.targets.some((t) => t.error) ? (
                        <ul className="mt-1 text-xs text-red-700">
                          {p.targets
                            .filter((t) => t.error)
                            .map((t) => (
                              <li key={t.id}>
                                {t.network}: {t.error}
                              </li>
                            ))}
                        </ul>
                      ) : null}
                    </div>
                    {p.status === "scheduled" ? (
                      <form action={cancelScheduledPostAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="brandId" value={brandId} />
                        <Button type="submit" variant="ghost" size="sm" className="text-red-600">
                          Stornieren
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardTitle>Medienbibliothek</CardTitle>
          <UploadForm brandId={brandId} />
          <ul className="mt-4 divide-y divide-zinc-100 text-sm">
            {media.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate" title={m.filename}>
                    {m.filename}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {(m.sizeBytes / 1024 / 1024).toFixed(1)} MB · {formatDate(m.createdAt)}
                  </div>
                </div>
                <form action={deleteMediaAction}>
                  <input type="hidden" name="mediaId" value={m.id} />
                  <input type="hidden" name="brandId" value={brandId} />
                  <button className="text-xs text-red-600 hover:underline">löschen</button>
                </form>
              </li>
            ))}
            {media.length === 0 ? <li className="py-2 text-zinc-500">Noch keine Dateien.</li> : null}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">Claude kann über MCP Videos per URL importieren (import_media_from_url) und dann veröffentlichen.</p>
        </Card>
      </div>
    </div>
  );
}
