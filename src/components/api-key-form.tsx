"use client";

import { useActionState } from "react";
import { createApiKeyAction, type ActionResult } from "@/app/actions";
import { Button, Input, Label } from "./ui";

export function ApiKeyForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createApiKeyAction, null);
  const key = state?.ok ? (state.data as { key?: string } | undefined)?.key : undefined;
  return (
    <form action={action} className="space-y-3">
      <div>
        <Label htmlFor="name">Bezeichnung</Label>
        <Input id="name" name="name" placeholder="z. B. Claude Desktop" defaultValue="Claude" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Erzeuge…" : "Neuen API-Key erzeugen"}
      </Button>
      {key ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <div className="mb-1 text-emerald-800">Jetzt kopieren, wird nur einmal angezeigt:</div>
          <code className="block break-all rounded bg-white p-2 text-xs">{key}</code>
        </div>
      ) : null}
      {state && !state.ok ? <p className="text-sm text-red-700">{state.error}</p> : null}
    </form>
  );
}
