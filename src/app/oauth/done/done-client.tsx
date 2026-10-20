"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/** Letzte Seite im Popup: meldet dem Hauptfenster das Ergebnis und schließt sich. */
export function DoneClient({ connected, error }: { connected: number; error: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const message = { source: "socialhub-connect", status: error ? "error" : "connected", connected, error };
    try {
      window.opener?.postMessage(message, window.location.origin);
    } catch {
      /* kein Opener */
    }
    try {
      new BroadcastChannel("socialhub-connect").postMessage(message);
    } catch {
      /* nicht verfügbar */
    }
    if (!error) {
      const t = setTimeout(() => window.close(), 1500);
      return () => clearTimeout(t);
    }
  }, [connected, error]);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-red-700">Verbindung fehlgeschlagen</h1>
            <p className="mt-2 text-sm text-zinc-700">{error}</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-emerald-700">
              {connected} {connected === 1 ? "Konto verbunden" : "Konten verbunden"}
            </h1>
            <p className="mt-2 text-sm text-zinc-600">Der erste Sync läuft. Dieses Fenster schließt sich automatisch.</p>
          </>
        )}
        <Button type="button" variant="secondary" className="mt-6" onClick={() => (window.opener ? window.close() : router.push("/"))}>
          Fenster schließen
        </Button>
      </div>
    </main>
  );
}
