"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { generateReportAction, type ActionResult } from "@/app/actions";
import { Button, Label, Select } from "./ui";

export function ReportGenerator({ brandId, claudeAvailable }: { brandId: string; claudeAvailable: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(generateReportAction, null);
  useEffect(() => {
    if (state?.ok && (state.data as { id?: string } | undefined)?.id) router.push(`/brands/${brandId}/reports/${(state.data as { id: string }).id}`);
  }, [state, router, brandId]);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="brandId" value={brandId} />
      <div>
        <Label htmlFor="days">Zeitraum</Label>
        <Select id="days" name="days" defaultValue="28">
          <option value="7">Letzte 7 Tage</option>
          <option value="28">Letzte 28 Tage</option>
          <option value="90">Letzte 90 Tage</option>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="withClaude" className="h-4 w-4" disabled={!claudeAvailable} />
        <span>
          Zusammenfassung von Claude {claudeAvailable ? "" : "(ANTHROPIC_API_KEY fehlt)"}
        </span>
      </label>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Erzeuge…" : "Daten-Report erzeugen"}
      </Button>
      {state && !state.ok ? <p className="text-sm text-red-700">{state.error}</p> : null}
      <p className="text-xs text-zinc-500">Tipp: Über MCP schreibt Claude ausführlichere Berichte mit Empfehlungen (Tool get_report_data → save_report).</p>
    </form>
  );
}
