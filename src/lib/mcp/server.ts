import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { env, configuredNetworks } from "../env";
import { NETWORKS } from "../db/schema";
import { allConnectors, connectorFor } from "../connectors/registry";
import { createBrand, findBrand, listBrands } from "../services/brands";
import { getConnection, listConnections } from "../services/connections";
import { audience, brandOverview, defaultPeriod, postsWithMetrics, timeseries, type Period } from "../services/analytics";
import { getReport, listReports, renderMarkdownReport, reportData, saveReport } from "../services/reports";
import { importMediaFromUrl, listMedia } from "../services/media";
import { cancelScheduledPost, createScheduledPost, getScheduledPost, listScheduledPosts } from "../services/publishing";
import { enqueue, waitForJob } from "../jobs/queue";

/**
 * MCP-Server: die Steuerschnittstelle für Claude. Jede Funktion der App ist als
 * Tool verfügbar, damit Claude autonom Analysen abrufen, Reports schreiben und
 * Videos veröffentlichen kann. Nur das OAuth-Verbinden braucht einen Menschen im Browser.
 */

const networkEnum = z.enum(NETWORKS);
const brandArg = z.string().describe("Brand-ID, Slug oder Name");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Fehler: ${(err as Error).message ?? String(err)}` }] };
}

type ToolFn<T> = (args: T) => Promise<unknown>;
function tool<T>(fn: ToolFn<T>) {
  return async (args: T) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

async function requireBrand(ref: string) {
  const b = await findBrand(ref);
  if (!b) throw new Error(`Brand "${ref}" nicht gefunden. Verfügbare Brands über list_brands.`);
  return b;
}

function period(args: { from?: string; to?: string; days?: number }): Period {
  if (args.from && args.to) return { from: args.from, to: args.to };
  return defaultPeriod(args.days ?? 28);
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_brands",
    { title: "Brands auflisten", description: "Alle Brands (Kunden/Projekte) mit ihren verbundenen Konten." },
    tool(async () => {
      const brands = await listBrands();
      const conns = await listConnections();
      return brands.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        timezone: b.timezone,
        connections: conns.filter((c) => c.brandId === b.id).map((c) => ({ id: c.id, network: c.network, name: c.name, status: c.status, lastSyncAt: c.lastSyncAt })),
      }));
    }),
  );

  server.registerTool(
    "create_brand",
    { title: "Brand anlegen", description: "Legt eine neue Brand an.", inputSchema: z.object({ name: z.string().min(1), timezone: z.string().default("Europe/Vienna") }) },
    tool(async ({ name, timezone }) => createBrand(name, timezone)),
  );

  server.registerTool(
    "get_network_capabilities",
    {
      title: "Netzwerk-Fähigkeiten",
      description: "Welche Netzwerke sind konfiguriert, welche Metriken, Zielgruppen-Dimensionen und Publishing-Optionen gibt es je Netzwerk.",
    },
    tool(async () => {
      const configured = configuredNetworks();
      return allConnectors().map((c) => ({
        network: c.network,
        label: c.label,
        configured: configured[c.network],
        connectUrlHint: `${env().APP_URL}/brands/<brandId> → "${c.label} verbinden" (OAuth im Browser durch einen Menschen)`,
        accountMetrics: c.accountMetrics,
        postMetrics: c.postMetrics,
        audienceDimensions: c.audienceDimensions,
        publishOptions: z.toJSONSchema(c.publishOptionsSchema),
        notes: c.notes,
      }));
    }),
  );

  server.registerTool(
    "list_connections",
    { title: "Verbindungen auflisten", description: "Verbundene Social-Konten, optional nur einer Brand.", inputSchema: z.object({ brand: brandArg.optional() }) },
    tool(async ({ brand }) => {
      const b = brand ? await requireBrand(brand) : null;
      const conns = await listConnections(b?.id);
      return conns.map((c) => ({
        id: c.id,
        brandId: c.brandId,
        network: c.network,
        name: c.name,
        username: c.username,
        status: c.status,
        statusMessage: c.statusMessage,
        tokenExpiresAt: c.tokenExpiresAt,
        lastSyncAt: c.lastSyncAt,
        scopes: c.scopes,
      }));
    }),
  );

  server.registerTool(
    "get_connect_url",
    {
      title: "Verbindungs-Link",
      description: "Liefert den Link, über den ein Mensch im Browser ein Konto per OAuth verbindet. Claude kann OAuth nicht selbst durchführen.",
      inputSchema: z.object({ brand: brandArg, network: networkEnum }),
    },
    tool(async ({ brand, network }) => {
      const b = await requireBrand(brand);
      const c = connectorFor(network);
      return {
        configured: c.configured(),
        url: `${env().APP_URL}/brands/${b.id}?connect=${c.provider}`,
        instructions: c.configured()
          ? `Link im Browser öffnen, bei ${c.label} anmelden und die Konten auswählen. Danach startet der erste Sync automatisch (ca. 1 bis 5 Minuten).`
          : `${c.label} ist nicht konfiguriert. In .env die App-Zugangsdaten eintragen (siehe README).`,
        notes: c.notes,
      };
    }),
  );

  server.registerTool(
    "sync_connection",
    {
      title: "Daten synchronisieren",
      description: "Holt die neuesten Analytics von der Plattform. Entweder eine connection_id oder alle Konten einer Brand. Wartet standardmäßig auf das Ergebnis (max. 3 Minuten).",
      inputSchema: z.object({
        connection_id: z.string().optional(),
        brand: brandArg.optional(),
        scope: z.enum(["all", "account", "posts", "audience"]).default("all"),
        backfill_days: z.number().int().min(1).max(365).optional().describe("Wie viele Tage rückwirkend (Standard: 90 beim ersten Sync, danach 7/30)"),
        wait: z.boolean().default(true),
      }),
    },
    tool(async ({ connection_id, brand, scope, backfill_days, wait }) => {
      let ids: string[] = [];
      if (connection_id) ids = [connection_id];
      else if (brand) ids = (await listConnections((await requireBrand(brand)).id)).map((c) => c.id);
      else throw new Error("connection_id oder brand angeben.");
      const jobs: { connectionId: string; jobId: string }[] = [];
      for (const id of ids) {
        const conn = await getConnection(id);
        if (!conn) throw new Error(`Verbindung ${id} nicht gefunden.`);
        const type = scope === "all" ? "sync.all" : (`sync.${scope}` as const);
        const jobId = await enqueue(type, { connectionId: id, backfillDays: backfill_days }, { uniqueKey: `${type}:${id}:manual` });
        jobs.push({ connectionId: id, jobId });
      }
      if (!wait) return { queued: jobs };
      const results = [];
      for (const j of jobs) {
        const job = await waitForJob(j.jobId, 180_000);
        const conn = await getConnection(j.connectionId);
        results.push({ connectionId: j.connectionId, network: conn?.network, name: conn?.name, status: job?.status ?? "unknown", result: job?.result, error: job?.lastError });
      }
      return results;
    }),
  );

  server.registerTool(
    "get_overview",
    {
      title: "Übersicht",
      description: "Kennzahlen aller Konten einer Brand (aktuelle vs. vorherige Periode) plus Top-Beiträge. Standard: letzte 28 Tage.",
      inputSchema: z.object({ brand: brandArg, from: dateArg.optional(), to: dateArg.optional(), days: z.number().int().min(1).max(365).optional() }),
    },
    tool(async (args) => {
      const b = await requireBrand(args.brand);
      const p = period(args);
      return { brand: { id: b.id, name: b.name }, period: p, connections: await brandOverview(b.id, p) };
    }),
  );

  server.registerTool(
    "get_timeseries",
    {
      title: "Zeitreihe",
      description: "Tageswerte ausgewählter Metriken eines Kontos. Metrik-Namen über get_network_capabilities.",
      inputSchema: z.object({ connection_id: z.string(), metrics: z.array(z.string()).min(1), from: dateArg.optional(), to: dateArg.optional(), days: z.number().int().optional() }),
    },
    tool(async (args) => timeseries(args.connection_id, args.metrics, period(args))),
  );

  server.registerTool(
    "get_posts",
    {
      title: "Beiträge mit Metriken",
      description: "Veröffentlichte Beiträge eines Kontos mit dem jeweils letzten Metrik-Stand.",
      inputSchema: z.object({
        connection_id: z.string(),
        from: dateArg.optional(),
        to: dateArg.optional(),
        days: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(50),
        sort_by: z.string().optional().describe("Metrik, nach der absteigend sortiert wird, z. B. views"),
      }),
    },
    tool(async (args) => {
      const posts = await postsWithMetrics(args.connection_id, { period: period(args), limit: args.limit, sortBy: args.sort_by });
      return posts.map((p) => ({ id: p.id, externalId: p.externalId, type: p.type, title: p.title, caption: p.caption, permalink: p.permalink, publishedAt: p.publishedAt, metrics: p.metrics }));
    }),
  );

  server.registerTool(
    "get_audience",
    { title: "Zielgruppe", description: "Demografie/Geografie eines Kontos (Alter, Geschlecht, Land, Stadt, Traffic-Quellen ...).", inputSchema: z.object({ connection_id: z.string() }) },
    tool(async ({ connection_id }) => audience(connection_id)),
  );

  server.registerTool(
    "get_report_data",
    {
      title: "Report-Daten",
      description: "Alle Daten für einen Bericht (Kennzahlen, Zeitreihen, Top-Beiträge, Zielgruppen) als JSON plus fertige Markdown-Tabellen. Daraus schreibt Claude den Bericht und speichert ihn mit save_report.",
      inputSchema: z.object({ brand: brandArg, from: dateArg.optional(), to: dateArg.optional(), days: z.number().int().optional() }),
    },
    tool(async (args) => {
      const b = await requireBrand(args.brand);
      const data = await reportData(b.id, period(args));
      return { markdownTables: renderMarkdownReport(b.name, data), data };
    }),
  );

  server.registerTool(
    "save_report",
    {
      title: "Report speichern",
      description: "Speichert einen fertigen Markdown-Bericht in der App.",
      inputSchema: z.object({ brand: brandArg, title: z.string().min(1), markdown: z.string().min(1), from: dateArg.optional(), to: dateArg.optional() }),
    },
    tool(async ({ brand, title, markdown, from, to }) => {
      const b = await requireBrand(brand);
      const r = await saveReport({ brandId: b.id, title, markdown, period: from && to ? { from, to } : undefined, createdBy: "mcp" });
      return { id: r.id, url: `${env().APP_URL}/brands/${b.id}/reports/${r.id}` };
    }),
  );

  server.registerTool(
    "list_reports",
    { title: "Reports auflisten", description: "Gespeicherte Berichte einer Brand.", inputSchema: z.object({ brand: brandArg }) },
    tool(async ({ brand }) => {
      const b = await requireBrand(brand);
      return (await listReports(b.id)).map((r) => ({ id: r.id, title: r.title, periodFrom: r.periodFrom, periodTo: r.periodTo, createdAt: r.createdAt, url: `${env().APP_URL}/brands/${b.id}/reports/${r.id}` }));
    }),
  );

  server.registerTool(
    "get_report",
    { title: "Report lesen", description: "Markdown eines gespeicherten Berichts.", inputSchema: z.object({ report_id: z.string() }) },
    tool(async ({ report_id }) => {
      const r = await getReport(report_id);
      if (!r) throw new Error("Report nicht gefunden.");
      return r.markdown;
    }),
  );

  server.registerTool(
    "list_media",
    { title: "Medienbibliothek", description: "Hochgeladene Videos/Bilder einer Brand (für publish_video).", inputSchema: z.object({ brand: brandArg }) },
    tool(async ({ brand }) => {
      const b = await requireBrand(brand);
      return (await listMedia(b.id)).map((m) => ({ id: m.id, filename: m.filename, mimeType: m.mimeType, sizeBytes: m.sizeBytes, createdAt: m.createdAt }));
    }),
  );

  server.registerTool(
    "import_media_from_url",
    {
      title: "Medium von URL importieren",
      description: "Lädt ein Video (MP4/MOV/WebM) von einer öffentlichen URL in die Medienbibliothek, damit es veröffentlicht werden kann.",
      inputSchema: z.object({ brand: brandArg, url: z.string().url(), filename: z.string().optional() }),
    },
    tool(async ({ brand, url, filename }) => {
      const b = await requireBrand(brand);
      const m = await importMediaFromUrl(b.id, url, filename);
      return { id: m.id, filename: m.filename, mimeType: m.mimeType, sizeBytes: m.sizeBytes };
    }),
  );

  server.registerTool(
    "get_publish_options",
    { title: "Publishing-Optionen", description: "JSON-Schema der netzwerkspezifischen Optionen (Privatsphäre, Tags, Reel/Story ...).", inputSchema: z.object({ network: networkEnum }) },
    tool(async ({ network }) => {
      const c = connectorFor(network);
      return { network, schema: z.toJSONSchema(c.publishOptionsSchema), notes: c.notes };
    }),
  );

  server.registerTool(
    "publish_video",
    {
      title: "Video veröffentlichen",
      description:
        "Veröffentlicht ein Video aus der Medienbibliothek auf einem oder mehreren Konten, sofort oder geplant. text = Beschreibung/Caption, title = Titel (YouTube/TikTok). Optionen je Ziel laut get_publish_options.",
      inputSchema: z.object({
        brand: brandArg,
        media_id: z.string(),
        text: z.string().default(""),
        title: z.string().optional(),
        targets: z.array(z.object({ connection_id: z.string(), options: z.record(z.string(), z.unknown()).optional() })).min(1),
        schedule_at: z.string().datetime({ offset: true }).optional().describe("ISO-8601 mit Zeitzone; leer = sofort"),
      }),
    },
    tool(async ({ brand, media_id, text: body, title, targets, schedule_at }) => {
      const b = await requireBrand(brand);
      const post = await createScheduledPost({
        brandId: b.id,
        mediaId: media_id,
        text: body,
        title: title ?? null,
        scheduledAt: schedule_at ? new Date(schedule_at) : null,
        targets: targets.map((t) => ({ connectionId: t.connection_id, options: t.options })),
        createdBy: "mcp",
      });
      return { id: post.id, status: post.status, scheduledAt: post.scheduledAt, targets: post.targets.map((t) => ({ id: t.id, network: t.network, connection: t.connectionName, status: t.status })), url: `${env().APP_URL}/brands/${b.id}/publish` };
    }),
  );

  server.registerTool(
    "get_publish_status",
    { title: "Veröffentlichungs-Status", description: "Status eines geplanten/veröffentlichten Posts inkl. Links.", inputSchema: z.object({ scheduled_post_id: z.string() }) },
    tool(async ({ scheduled_post_id }) => {
      const p = await getScheduledPost(scheduled_post_id);
      if (!p) throw new Error("Post nicht gefunden.");
      return { id: p.id, status: p.status, scheduledAt: p.scheduledAt, text: p.text, targets: p.targets.map((t) => ({ network: t.network, connection: t.connectionName, status: t.status, permalink: t.permalink, error: t.error })) };
    }),
  );

  server.registerTool(
    "list_scheduled_posts",
    {
      title: "Geplante Posts",
      description: "Geplante, laufende und veröffentlichte Posts einer Brand.",
      inputSchema: z.object({ brand: brandArg, status: z.enum(["draft", "scheduled", "publishing", "published", "partial", "failed", "cancelled"]).optional(), limit: z.number().int().default(50) }),
    },
    tool(async ({ brand, status, limit }) => {
      const b = await requireBrand(brand);
      return (await listScheduledPosts(b.id, { status, limit })).map((p) => ({ id: p.id, status: p.status, scheduledAt: p.scheduledAt, text: p.text.slice(0, 120), targets: p.targets.map((t) => ({ network: t.network, status: t.status, permalink: t.permalink })) }));
    }),
  );

  server.registerTool(
    "cancel_scheduled_post",
    { title: "Geplanten Post stornieren", description: "Storniert einen noch nicht veröffentlichten Post.", inputSchema: z.object({ scheduled_post_id: z.string() }) },
    tool(async ({ scheduled_post_id }) => {
      await cancelScheduledPost(scheduled_post_id);
      return { cancelled: true };
    }),
  );

  server.registerPrompt(
    "weekly_report",
    {
      title: "Wochenbericht",
      description: "Erstellt einen Wochenbericht für eine Brand (Daten holen, analysieren, speichern).",
      argsSchema: z.object({ brand: z.string() }),
    },
    ({ brand }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Erstelle einen Social-Media-Wochenbericht für die Brand "${brand}". Vorgehen: 1) sync_connection für die Brand (wait=true). 2) get_report_data mit days=7. 3) Schreibe einen Bericht auf Deutsch: Zusammenfassung, Kennzahlen je Netzwerk mit Veränderung zur Vorwoche, Top-3-Beiträge mit Begründung, Zielgruppen-Erkenntnisse, 3 bis 5 konkrete Empfehlungen für nächste Woche. 4) Speichere ihn mit save_report und gib den Link zurück.`,
          },
        },
      ],
    }),
  );
}
