"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui";

/** Upload mit Fortschrittsanzeige (XHR, weil fetch keinen Upload-Progress liefert). */
export function UploadForm({ brandId }: { brandId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = (file: File) => {
    setError(null);
    setProgress(0);
    const fd = new FormData();
    fd.set("brandId", brandId);
    fd.set("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        if (input.current) input.current.value = "";
        router.refresh();
      } else {
        try {
          setError(JSON.parse(xhr.responseText).error ?? `Fehler ${xhr.status}`);
        } catch {
          setError(`Fehler ${xhr.status}`);
        }
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setError("Upload fehlgeschlagen");
    };
    xhr.send(fd);
  };

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png" className="block w-full text-sm" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {progress !== null ? (
        <div className="h-2 w-full overflow-hidden rounded bg-zinc-200">
          <div className="h-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>
        Datei wählen
      </Button>
    </div>
  );
}
