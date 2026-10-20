"use client";

import { useActionState, useId, useMemo, useState } from "react";
import { createScheduledPostAction, type ActionResult } from "@/app/actions";
import { Button, Input, Label, Select, Textarea } from "./ui";
import { NetworkBadge } from "./network-badge";
import type { Network } from "@/lib/db/schema";

export interface ConnOption {
  id: string;
  network: Network;
  name: string;
  status: string;
}
export interface MediaOption {
  id: string;
  filename: string;
  sizeBytes: number;
}
/** Vereinfachtes JSON-Schema der Publishing-Optionen je Netzwerk (aus zod). */
export interface OptionField {
  key: string;
  type: "boolean" | "string" | "number" | "enum" | "array";
  enum?: string[];
  default?: unknown;
  description?: string;
}

export function PublishForm({
  brandId,
  timezone,
  connections,
  media,
  fields,
  notes,
}: {
  brandId: string;
  timezone: string;
  connections: ConnOption[];
  media: MediaOption[];
  fields: Record<Network, OptionField[]>;
  notes: Record<Network, string[]>;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createScheduledPostAction, null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<Record<string, Record<string, unknown>>>({});
  const [mediaId, setMediaId] = useState(media[0]?.id ?? "");

  const targets = useMemo(
    () =>
      connections
        .filter((c) => selected[c.id])
        .map((c) => ({ connectionId: c.id, options: options[c.id] ?? {} })),
    [connections, selected, options],
  );

  const setOpt = (connId: string, key: string, value: unknown) => setOptions((o) => ({ ...o, [connId]: { ...(o[connId] ?? {}), [key]: value } }));

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="timezone" value={timezone} />
      <input type="hidden" name="targets" value={JSON.stringify(targets)} />

      <div>
        <Label htmlFor="mediaId">Video</Label>
        <Select id="mediaId" name="mediaId" value={mediaId} onChange={(e) => setMediaId(e.target.value)} required>
          <option value="">Bitte wählen…</option>
          {media.map((m) => (
            <option key={m.id} value={m.id}>
              {m.filename} ({(m.sizeBytes / 1024 / 1024).toFixed(1)} MB)
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="title">Titel (YouTube, TikTok, LinkedIn-Medientitel)</Label>
          <Input id="title" name="title" maxLength={100} placeholder="Optional" />
        </div>
        <div>
          <Label htmlFor="scheduledAt">Zeitpunkt ({timezone})</Label>
          <Input id="scheduledAt" name="scheduledAt" type="datetime-local" />
          <p className="mt-1 text-xs text-zinc-500">Leer lassen = sofort veröffentlichen.</p>
        </div>
      </div>

      <div>
        <Label htmlFor="text">Beschreibung / Caption</Label>
        <Textarea id="text" name="text" rows={5} placeholder="Text, Hashtags, Erwähnungen…" />
      </div>

      <div>
        <Label>Zielkonten</Label>
        <div className="space-y-3">
          {connections.map((c) => (
            <div key={c.id} className="rounded-md border border-zinc-200 p-3">
              <label className="flex items-center gap-3">
                <input type="checkbox" className="h-4 w-4" checked={!!selected[c.id]} disabled={c.status === "reauth_required"} onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} />
                <NetworkBadge network={c.network} />
                <span className="text-sm font-medium">{c.name}</span>
                {c.status === "reauth_required" ? <span className="text-xs text-red-600">neu verbinden</span> : null}
              </label>
              {selected[c.id] && fields[c.network]?.length ? (
                <div className="mt-3 grid gap-3 border-t border-zinc-100 pt-3 sm:grid-cols-2">
                  {fields[c.network].map((f) => (
                    <OptionInput key={f.key} field={f} value={options[c.id]?.[f.key]} onChange={(v) => setOpt(c.id, f.key, v)} />
                  ))}
                  {notes[c.network]?.length ? (
                    <ul className="sm:col-span-2 list-disc pl-5 text-xs text-zinc-500">
                      {notes[c.network].map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {connections.length === 0 ? <p className="text-sm text-zinc-500">Noch keine Konten verbunden.</p> : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || targets.length === 0 || !mediaId}>
          {pending ? "Wird angelegt…" : "Veröffentlichen / planen"}
        </Button>
        {state ? <span className={`text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.ok ? state.message : state.error}</span> : null}
      </div>
    </form>
  );
}

function OptionInput({ field, value, onChange }: { field: OptionField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `opt-${field.key}-${useId()}`;
  const label = field.description ? `${field.key} – ${field.description}` : field.key;
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4" checked={value === undefined ? !!field.default : !!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  if (field.type === "enum") {
    return (
      <div>
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <Select id={id} value={String(value ?? field.default ?? "")} onChange={(e) => onChange(e.target.value)}>
          {field.enum?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <div>
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <Input id={id} type="number" value={value === undefined ? String(field.default ?? "") : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      </div>
    );
  }
  if (field.type === "array") {
    return (
      <div>
        <Label htmlFor={id} className="text-xs">
          {label} (kommagetrennt)
        </Label>
        <Input id={id} value={Array.isArray(value) ? value.join(", ") : ""} onChange={(e) => onChange(e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined)} />
      </div>
    );
  }
  return (
    <div>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)} />
    </div>
  );
}
