"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui";

/**
 * Öffnet den OAuth-Flow in einem Popup (wie Metricool) und wartet auf die
 * Rückmeldung per postMessage / BroadcastChannel; danach wird die Seite aktualisiert.
 */
export function ConnectButton({ brandId, provider, label, disabled, autoOpen }: { brandId: string; provider: string; label: string; disabled?: boolean; autoOpen?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.source !== "socialhub-connect") return;
      setBusy(false);
      router.refresh();
    };
    window.addEventListener("message", onMessage);
    const bc = new BroadcastChannel("socialhub-connect");
    bc.addEventListener("message", onMessage as EventListener);
    const timer = window.setInterval(() => {
      if (popup.current && popup.current.closed) {
        setBusy(false);
        popup.current = null;
        router.refresh();
      }
    }, 800);
    return () => {
      window.removeEventListener("message", onMessage);
      bc.close();
      window.clearInterval(timer);
    };
  }, [router]);

  const open = () => {
    const w = 640;
    const h = 780;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const url = `/api/oauth/${provider}/start?brandId=${encodeURIComponent(brandId)}`;
    popup.current = window.open(url, "socialhub-oauth", `width=${w},height=${h},left=${left},top=${top},popup=1`);
    if (!popup.current) {
      router.push(url); // Popup blockiert → im selben Tab
      return;
    }
    setBusy(true);
  };

  useEffect(() => {
    if (autoOpen && !disabled) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);

  return (
    <Button type="button" variant="secondary" size="sm" onClick={open} disabled={disabled || busy}>
      {busy ? "Warte auf Freigabe…" : label}
    </Button>
  );
}
