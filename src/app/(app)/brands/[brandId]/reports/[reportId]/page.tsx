import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, formatDate } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { getReport } from "@/lib/services/reports";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ brandId: string; reportId: string }> }) {
  const { brandId, reportId } = await params;
  const report = await getReport(reportId);
  if (!report || report.brandId !== brandId) notFound();
  return (
    <div className="space-y-4">
      <Link href={`/brands/${brandId}/reports`} className="text-sm text-zinc-500 hover:underline">
        ← Reports
      </Link>
      <Card>
        <div className="mb-4 text-xs text-zinc-500">
          {formatDate(report.createdAt)} · via {report.createdBy}
        </div>
        <Markdown>{report.markdown}</Markdown>
      </Card>
    </div>
  );
}
