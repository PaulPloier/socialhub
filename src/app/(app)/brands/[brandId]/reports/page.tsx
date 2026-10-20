import Link from "next/link";
import { Card, CardTitle, Empty, formatDate } from "@/components/ui";
import { ReportGenerator } from "@/components/report-generator";
import { listReports } from "@/lib/services/reports";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const reports = await listReports(brandId);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardTitle>Reports</CardTitle>
          {reports.length === 0 ? (
            <Empty>Noch keine Reports. Erzeuge rechts einen Daten-Report oder lass Claude über MCP einen schreiben (Prompt „weekly_report“).</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {reports.map((r) => (
                <li key={r.id} className="py-3">
                  <Link href={`/brands/${brandId}/reports/${r.id}`} className="font-medium hover:underline">
                    {r.title}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    {r.periodFrom && r.periodTo ? `${r.periodFrom} bis ${r.periodTo} · ` : ""}
                    {formatDate(r.createdAt)} · via {r.createdBy}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card>
        <CardTitle>Report erzeugen</CardTitle>
        <ReportGenerator brandId={brandId} claudeAvailable={!!env().ANTHROPIC_API_KEY} />
      </Card>
    </div>
  );
}
