"use client";

import { useActionState } from "react";
import { syncConnectionAction, type ActionResult } from "@/app/actions";
import { Button } from "./ui";

export function SyncButton({ connectionId, backfillDays, label = "Jetzt synchronisieren" }: { connectionId: string; backfillDays?: number; label?: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(syncConnectionAction, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      {backfillDays ? <input type="hidden" name="backfillDays" value={backfillDays} /> : null}
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Starte…" : label}
      </Button>
      {state ? <span className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.ok ? state.message : state.error}</span> : null}
    </form>
  );
}
