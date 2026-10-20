import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Report } from "../db/schema";
import { connectorFor } from "../connectors/registry";
import { audience, brandOverview, timeseries, type Period } from "./analytics";
import { env } from "../env";

/** Strukturierte Report-Daten (für Claude über MCP oder den internen Generator). */
export async function reportData(brandId: string, period: Period) {
  const overview = await brandOverview(brandId, period, 10);
  const details = [];
  for (const o of overview) {
    const connector = connectorFor(o.connection.network);
    const metrics = connector.accountMetrics.filter((m) => m.aggregation === "sum").map((m) => m.key).slice(0, 6);
    details.push({
      ...o,
      series: await timeseries(o.connection.id, metrics, period),
      audience: await audience(o.connection.id),
      notes: connector.notes,
    });
  }
  return { brandId, period, connections: details };
}

/** Deterministischer Markdown-Report aus den Daten (ohne KI). */
export function renderMarkdownReport(brandName: string, data: Awaited<ReturnType<typeof reportData>>): string {
  const lines: string[] = [];
  lines.push(`# Social-Media-Report: ${brandName}`);
  lines.push(`Zeitraum: ${data.period.from} bis ${data.period.to}`);
  lines.push("");
  for (const c of data.connections) {
    lines.push(`## ${connectorFor(c.connection.network).label}: ${c.connection.name}`);
    if (c.connection.status !== "active") lines.push(`> Status: ${c.connection.status} ${c.connection.statusMessage ?? ""}`);
    lines.push("");
    lines.push("| Kennzahl | Aktuell | Vorperiode | Veränderung |");
    lines.push("|---|---:|---:|---:|");
    for (const k of c.kpis) {
      lines.push(`| ${k.label} | ${fmt(k.value)} | ${fmt(k.previous)} | ${k.changePct === null ? "–" : `${k.changePct > 0 ? "+" : ""}${k.changePct.toFixed(1)} %`} |`);
    }
    lines.push("");
    if (c.topPosts.length) {
      lines.push(`**Top-Beiträge (${c.postCount} im Zeitraum)**`);
      lines.push("");
      for (const p of c.topPosts.slice(0, 5)) {
        const m = Object.entries(p.metrics)
          .slice(0, 5)
          .map(([k, v]) => `${k}: ${fmt(v)}`)
          .join(", ");
        lines.push(`- ${p.publishedAt.toISOString().slice(0, 10)} ${p.permalink ? `[${p.type}](${p.permalink})` : p.type}: ${(p.caption ?? "").replace(/\s+/g, " ").slice(0, 80)} (${m})`);
      }
      lines.push("");
    }
    const aud = c.audience;
    for (const dim of Object.keys(aud).slice(0, 4)) {
      const top = aud[dim].slice(0, 6).map((r) => `${r.key} ${fmt(r.value)}`).join(", ");
      lines.push(`- Zielgruppe ${dim}: ${top}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function fmt(v: number | null): string {
  if (v === null || v === undefined) return "–";
  if (Number.isInteger(v)) return v.toLocaleString("de-AT");
  return v.toLocaleString("de-AT", { maximumFractionDigits: 1 });
}

export async function saveReport(input: { brandId: string; title: string; markdown: string; period?: Period; createdBy?: string }): Promise<Report> {
  const db = await getDb();
  const [row] = await db
    .insert(schema.reports)
    .values({
      id: crypto.randomUUID(),
      brandId: input.brandId,
      title: input.title,
      markdown: input.markdown,
      periodFrom: input.period?.from ?? null,
      periodTo: input.period?.to ?? null,
      createdBy: input.createdBy ?? "ui",
    })
    .returning();
  return row;
}

export async function listReports(brandId: string): Promise<Report[]> {
  const db = await getDb();
  return db.query.reports.findMany({ where: eq(schema.reports.brandId, brandId), orderBy: desc(schema.reports.createdAt) });
}

export async function getReport(id: string): Promise<Report | undefined> {
  const db = await getDb();
  return db.query.reports.findFirst({ where: eq(schema.reports.id, id) });
}

/** Optional: Claude schreibt in der App selbst eine Einordnung (ANTHROPIC_API_KEY nötig). */
export async function narrateWithClaude(markdownData: string, brandName: string): Promise<string | null> {
  const e = env();
  if (!e.ANTHROPIC_API_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": e.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: e.ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Du bist Social-Media-Analyst für die Marke "${brandName}". Schreibe auf Deutsch eine kurze Management-Zusammenfassung (max. 300 Wörter) mit 3 bis 5 konkreten Empfehlungen auf Basis dieser Daten:\n\n${markdownData}`,
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  return json.content?.find((c) => c.type === "text")?.text ?? null;
}
